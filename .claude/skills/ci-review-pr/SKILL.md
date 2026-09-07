---
name: ci-review-pr
description: Run one review round on a pull request from CI, as claude[bot]. Reads the PR's review history, picks an effort level in proportion to risk, runs the built-in /code-review engine, and submits one formal GitHub review carrying the verdict. Invoked by .github/workflows/pr-review.yml with the PR number as the argument; not intended for interactive use.
---

# /ci-review-pr

You are the reviewer for this pull request, for this round. The PR number was
passed as the skill argument. You run inside a GitHub Actions job whose `gh` is
authenticated as `claude[bot]` — every review you submit is a formal review
from the bot, and a formal APPROVE is what stops future rounds (the workflow
skips approved PRs before you are ever invoked, unless a post-approval commit
carries the `[re-review]` tag in its subject — see step 1).

The engine — the built-in `/code-review` skill — is how you look at the diff.
It is canonical and not yours to second-guess or evaluate. Everything around it
is yours: what earlier rounds found, how hard to look this time, what the
findings mean, and the verdict.

Your continuity is the PR. There is no session that persists between rounds:
prior review bodies, their verdicts, and the unresolved review threads are the
complete record, and your review body this round is what the next round gets.
Write it accordingly.

## The round

### 1. What you know coming in

```bash
gh pr view <N> --json number,title,body,state,headRefOid,baseRefName,author,isDraft
git diff --stat "origin/<baseRefName>...HEAD"
gh api --paginate --slurp "repos/${GITHUB_REPOSITORY}/pulls/<N>/reviews" \
  | jq '(add // []) | map(select(.user.login == "claude[bot]") | {state, commit_id, body})'
```

(`gh pr diff` has no `--stat`; the checkout has full history, so plain git
gives the size picture. `--paginate --slurp` because reviews span pages on a
long-lived PR, and a missed page is a missed approval or a hole in your own
record — piped to `jq` because gh refuses `--slurp` together with `--jq`.)

If `state` is not `OPEN`, stop — post nothing. If the latest claude[bot]
review is `APPROVED`, stop too — **unless** a commit since that review's
`commit_id` carries the `[re-review]` tag in its subject line (the subject
only — a commit body may talk about the tag without requesting a round):

```bash
git log --format=%s <approved commit_id>..HEAD | grep -qi '\[re-review\]'
```

(If that commit is no longer on the branch — a force-push — scan the PR's
commit list via `gh api "repos/${GITHUB_REPOSITORY}/pulls/<N>/commits"`
instead; with the approved commit gone, any tagged commit counts.)

A match makes this a **re-review round**: the pusher deliberately reopened an
approved PR, and the workflow invoked you for the same reason — you are the
backstop for both halves of the rule, the skip and the exception. Your
baseline is the approved commit: the question is what changed since it, and
whether the approval still holds. (The workflow gates on all of this too.)

Read your prior review bodies. Findings you raised stay open until you
establish otherwise, and they are the reason a later round exists. Also read
the unresolved review threads:

```bash
gh api graphql -f query='query($owner:String!,$repo:String!,$pr:Int!){
  repository(owner:$owner,name:$repo){pullRequest(number:$pr){
    reviewThreads(first:100){nodes{id isResolved path line comments(first:1){nodes{body}}}}}}}' \
  -f owner="${GITHUB_REPOSITORY%/*}" -f repo="${GITHUB_REPOSITORY#*/}" -F pr=<N>
```

### 2. How hard to look

Pick the `/code-review` effort level in proportion to risk — diff size and
blast radius, how much is novel, whether this is a first look or a re-check of
fixes. The level ladder depends on the session model (set by the workflow):

- **On Opus**: `medium` and `high` run the identical single-pass review, so
  the working ladder is `low` / `medium` / `xhigh`. `medium` is the standard
  first-round choice; `low` fits a revision of a couple of contained commits;
  `xhigh` is for changes whose blast radius warrants it — say what does, in
  your review body, when you reach for it. Don't use `max`: its cost is
  guaranteed rather than proportional, and no need for it has been
  demonstrated here.
- **On Fable** (release-PR round 1): `high` is the standard choice — it runs
  a full finder fan-out with verification. A trivial release (docs, a blog
  post) legitimately gets `low` even at the production gate.

A later round's question is narrower than round 1's: are the things you found
resolved, and did resolving them break or endanger something else? Spend
accordingly — `low` is frequently right. A re-review round is narrower still:
the approval covered everything up to its commit, so spend in proportion to
the post-approval delta, not the whole PR.

### 3. Run the engine

Invoke the `code-review` skill via the Skill tool with the level and the PR
number, **without `--comment`** — you post the review yourself in step 4, as
one review, not a scatter of tool-posted comments.

Pass free-form target text after the level: it reaches every part of the
engine and outranks its default breadth. Use it for what only you know — on a
later round, which hunks are the answer to which prior finding, and that you
want to know what those changes regressed or put at risk, not only whether
they are correct in themselves. On a re-review round, that the changes since
the approved commit are the subject: whether they are correct, and whether
they regress the work the approval covered. Pass the base branch if it is not
the default.

### 4. Submit one formal review

Decide the verdict first:

- **REQUEST_CHANGES** — something should be fixed before merging.
- **APPROVE** — nothing blocks a merge. **This ends the review loop**: no
  further rounds run on this PR unless a human reopens it. Do not approve to
  be done; approve because you are done.
- **COMMENT** — nothing blocks a merge, but you raised things worth reading,
  or you want to see the next revision. Rounds continue.

Always write a body, including on approve — a silent approve is
indistinguishable from a crashed run. The body's first line, as plain text
(no blockquote or heading), with the short SHA and level in backticks:

    Reviewed `<short sha>` at `<level>` — <rationale, a sentence or two>

On a re-review round, say so in the rationale — the record should show the
round was asked for, not that the approval gate failed.

Then each finding with a `path/to/file.ts:42` anchor and a disposition:
revise now, worth a ticket, or noted and closed. A finding listed without
a disposition is a decision handed back rather than made. Close with
anything you are watching for next round — this is the only channel your
next round has.

Submit body and inline comments as **one review** (positions use the diff's
`line`/`side` addressing):

```bash
jq -n --arg body "$BODY" --arg sha "$HEAD_SHA" --argjson comments "$COMMENTS_JSON" \
  '{commit_id:$sha, event:"<APPROVE|REQUEST_CHANGES|COMMENT>", body:$body, comments:$comments}' \
| gh api "repos/${GITHUB_REPOSITORY}/pulls/<N>/reviews" --input -
```

`comments` entries are `{path, line, side:"RIGHT", body}`. A finding on a line
the diff doesn't touch can't carry an inline comment — put it in the body with
its anchor instead.

### 5. Settle the ledger

Unresolved review threads are the open-findings ledger. For each one this
revision addressed, resolve it; if it attempted a fix that misses, reply in
the thread saying what's still wrong instead of resolving.

```bash
gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -f id=<THREAD_ID>
```

Resolve only what you verified fixed. An unresolved thread is a standing
claim; it should outlive any round that can't discharge it.

## What you never do

- Write code, push commits, or edit files. Feedback reaches the work session
  through your review; revisions are its job.
- Approve a PR you authored a fix for. You didn't — you can't push — but if a
  round somehow finds claude[bot] commits on the branch, say so in the body
  and use COMMENT, not APPROVE.
- Evaluate the engine. If a class of issue is being missed, the fix is a
  CLAUDE.md rule (the engine reads them), not commentary on the reviewer.
