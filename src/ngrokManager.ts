import ngrok from "@ngrok/ngrok";
import { randomBytes } from "crypto";

export interface TunnelInfo {
  listener: ngrok.Listener;
  url: string;
  auth: {
    user: string;
    pass: string;
  };
  port: number;
  sessionId: string;
}

/**
 * NgrokManager - Manages ngrok tunnels for exposing localhost services
 * to Browserbase cloud browsers.
 *
 * Tunnels are session-scoped: created on-demand when navigating to localhost,
 * and cleaned up when the browser session closes.
 *
 * Each tunnel has random basic auth credentials for security.
 */

export class NgrokManager {
  // Keyed by `${sessionId}:${port}` - allows same port across sessions
  private tunnels: Map<string, TunnelInfo> = new Map();

  /**
   * Ensure a tunnel exists for the given port and session.
   * Reuses existing tunnel if one exists for the same session+port.
   */
  async ensureTunnel(port: number, sessionId: string): Promise<TunnelInfo> {
    const key = `${sessionId}:${port}`;

    // Reuse existing tunnel for this session+port
    const existing = this.tunnels.get(key);
    if (existing) {
      process.stderr.write(`[NgrokManager] Reusing tunnel for port ${port} (session ${sessionId})\n`);
      return existing;
    }

    // Check for NGROK_AUTHTOKEN
    if (!process.env.NGROK_AUTHTOKEN) {
      throw new Error(
        "NGROK_AUTHTOKEN environment variable is required for localhost tunneling. " +
        "Cannot reach localhost from Browserbase cloud browser without ngrok."
      );
    }

    // Generate random credentials
    const auth = {
      user: randomBytes(8).toString("hex"),
      pass: randomBytes(16).toString("hex"),
    };

    process.stderr.write(`[NgrokManager] Creating tunnel for localhost:${port} (session ${sessionId})\n`);

    try {
      // pooling_enabled avoids ERR_NGROK_334 when stale endpoints exist
      // (e.g., previous run crashed without cleanup)
      // Note: pooling_enabled is not in the Config type but works at runtime
      const listener = await ngrok.forward({
        addr: port,
        authtoken: process.env.NGROK_AUTHTOKEN,
        basic_auth: [`${auth.user}:${auth.pass}`],
        pooling_enabled: true,
      } as Parameters<typeof ngrok.forward>[0]);

      const url = listener.url();
      if (!url) {
        throw new Error("ngrok listener did not return a URL");
      }

      const tunnelInfo: TunnelInfo = {
        listener,
        url,
        auth,
        port,
        sessionId,
      };

      this.tunnels.set(key, tunnelInfo);
      process.stderr.write(`[NgrokManager] Tunnel created: ${url} -> localhost:${port}\n`);

      return tunnelInfo;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`ngrok tunnel failed: ${errorMsg}. Check NGROK_AUTHTOKEN.`);
    }
  }

  /**
   * Get tunnel info for a session+port if it exists.
   */
  getTunnel(port: number, sessionId: string): TunnelInfo | undefined {
    return this.tunnels.get(`${sessionId}:${port}`);
  }

  /**
   * Close all tunnels for a specific session.
   * Called when a browser session is closed.
   */
  async closeSessionTunnels(sessionId: string): Promise<void> {
    const toClose: string[] = [];

    for (const [key, tunnel] of this.tunnels.entries()) {
      if (tunnel.sessionId === sessionId) {
        toClose.push(key);
      }
    }

    for (const key of toClose) {
      const tunnel = this.tunnels.get(key);
      if (tunnel) {
        try {
          process.stderr.write(`[NgrokManager] Closing tunnel for port ${tunnel.port} (session ${sessionId})\n`);
          await tunnel.listener.close();
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          process.stderr.write(`[NgrokManager] WARN - Error closing tunnel: ${errorMsg}\n`);
        }
        this.tunnels.delete(key);
      }
    }
  }

  /**
   * Close all tunnels. Called on MCP server shutdown.
   */
  async closeAll(): Promise<void> {
    process.stderr.write(`[NgrokManager] Closing all tunnels...\n`);

    for (const [key, tunnel] of this.tunnels.entries()) {
      try {
        await tunnel.listener.close();
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[NgrokManager] WARN - Error closing tunnel ${key}: ${errorMsg}\n`);
      }
    }

    this.tunnels.clear();
    process.stderr.write(`[NgrokManager] All tunnels closed\n`);
  }

  /**
   * Get count of active tunnels.
   */
  getActiveTunnelCount(): number {
    return this.tunnels.size;
  }
}
