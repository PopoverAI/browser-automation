import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "net";
import { Browserbase } from "@browserbasehq/sdk";
import type { SessionManager } from "./sessionManager.js";
import type { Config } from "../config.d.ts";

/**
 * Find an available port by binding to port 0 and checking what we got.
 */
async function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("Could not determine port")));
      }
    });
    server.on("error", reject);
  });
}

/**
 * CDP Proxy - WebSocket proxy that forwards Chrome DevTools Protocol
 * messages between Playwright MCP and a Browserbase cloud session.
 *
 * Uses dynamic port allocation to avoid conflicts when multiple
 * stagehand-mcp instances run (e.g., multiple Claude Code tabs).
 */

export class CdpProxy {
  private server: WebSocketServer | null = null;
  private sessionManager: SessionManager;
  private config: Config;
  private port: number | null = null;
  private bbClient: Browserbase | null = null;

  constructor(sessionManager: SessionManager, config: Config) {
    this.sessionManager = sessionManager;
    this.config = config;
  }

  private getBrowserbaseClient(): Browserbase {
    if (!this.bbClient) {
      this.bbClient = new Browserbase({ apiKey: this.config.browserbaseApiKey! });
    }
    return this.bbClient;
  }

  /**
   * Start the CDP proxy on a dynamically allocated port.
   * Returns the port number for use by Playwright federation.
   */
  async start(): Promise<number> {
    if (this.server && this.port) {
      process.stderr.write(`[CdpProxy] Already running on port ${this.port}\n`);
      return this.port;
    }

    // Find an available port
    this.port = await findAvailablePort();

    this.server = new WebSocketServer({ port: this.port });

    this.server.on("connection", (clientWs) => {
      this.handleConnection(clientWs);
    });

    this.server.on("error", (error) => {
      process.stderr.write(`[CdpProxy] Server error: ${error.message}\n`);
    });

    process.stderr.write(`[CdpProxy] Listening on ws://localhost:${this.port}\n`);
    return this.port;
  }

  private async handleConnection(clientWs: WebSocket): Promise<void> {
    process.stderr.write(`[CdpProxy] Client connected\n`);

    // Buffer messages from client until upstream is ready
    const messageBuffer: Buffer[] = [];
    let upstreamWs: WebSocket | null = null;
    let upstreamReady = false;

    // Set up client message handler IMMEDIATELY to capture early messages
    clientWs.on("message", (data: Buffer) => {
      const msgStr = data.toString();
      if (upstreamReady && upstreamWs?.readyState === WebSocket.OPEN) {
        upstreamWs.send(msgStr);
      } else {
        messageBuffer.push(data);
      }
    });

    clientWs.on("error", (error) => {
      process.stderr.write(`[CdpProxy] Client error: ${error.message}\n`);
      upstreamWs?.close();
    });

    clientWs.on("close", () => {
      upstreamWs?.close();
    });

    try {
      // Get the active session
      const activeSessionId = this.sessionManager.getActiveSessionId();
      const session = await this.sessionManager.getSession(
        activeSessionId,
        this.config,
        false // Don't create if missing
      );

      if (!session) {
        process.stderr.write(`[CdpProxy] No active session found\n`);
        clientWs.close(4000, "No active Browserbase session. Call stagehand_session_create with cloud=true first.");
        return;
      }

      const isCloud = !!session.stagehand.browserbaseSessionId;
      let cdpUrl: string;

      if (isCloud) {
        // Cloud: use debug wsUrl for secondary CDP connection (connectUrl doesn't support concurrent connections)
        const browserbaseSessionId = session.stagehand.browserbaseSessionId!;
        process.stderr.write(
          `[CdpProxy] Cloud session detected (${browserbaseSessionId}), fetching debug wsUrl...\n`
        );
        try {
          const bb = this.getBrowserbaseClient();
          const debugInfo = await bb.sessions.debug(browserbaseSessionId);
          cdpUrl = debugInfo.wsUrl;
          if (!cdpUrl) {
            throw new Error("sessions.debug() returned empty wsUrl");
          }
          process.stderr.write(`[CdpProxy] Got debug wsUrl for cloud session\n`);
        } catch (debugError) {
          const msg = debugError instanceof Error ? debugError.message : String(debugError);
          process.stderr.write(`[CdpProxy] Failed to get debug wsUrl: ${msg}\n`);
          clientWs.close(4002, `Failed to get Browserbase debug URL: ${msg}`);
          return;
        }
      } else {
        // Local: use Stagehand's connectURL directly (Chrome supports concurrent CDP connections)
        cdpUrl = session.stagehand.connectURL();
        if (!cdpUrl) {
          process.stderr.write(`[CdpProxy] No CDP URL available from session\n`);
          clientWs.close(4001, "No CDP URL available from session.");
          return;
        }
      }

      process.stderr.write(
        `[CdpProxy] Connecting to ${isCloud ? "Browserbase debug" : "local"} CDP: ${cdpUrl.substring(0, 60)}...\n`
      );

      // Connect to Browserbase CDP
      upstreamWs = new WebSocket(cdpUrl);

      upstreamWs.on("open", () => {
        process.stderr.write(`[CdpProxy] Connected to Browserbase, flushing ${messageBuffer.length} buffered messages\n`);
        upstreamReady = true;

        // Flush buffered messages - convert Buffer to string for CDP
        for (const data of messageBuffer) {
          upstreamWs!.send(data.toString());
        }
        messageBuffer.length = 0;
      });

      upstreamWs.on("message", (data) => {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(data);
        }
      });

      upstreamWs.on("close", () => {
        clientWs.close();
      });

      upstreamWs.on("error", (error) => {
        process.stderr.write(`[CdpProxy] Upstream error: ${error.message}\n`);
        clientWs.close(4003, `Browserbase connection error: ${error.message}`);
      });

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[CdpProxy] Connection handling error: ${errorMsg}\n`);
      clientWs.close(4004, `Proxy error: ${errorMsg}`);
    }
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      process.stderr.write(`[CdpProxy] Stopped\n`);
    }
  }

  getPort(): number | null {
    return this.port;
  }
}
