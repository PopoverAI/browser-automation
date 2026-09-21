---
name: ci-review-pr
description: Run one review round on a pull request from CI, as claude[bot]. Reads the PR's review history, picks an effort level in proportion to risk, runs the built-in /code-review engine, and submits one formal GitHub review carrying the outcome. Invoked by .github/workflows/pr-review.yml with the PR number as the argument; not intended for interactive use.
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
findings mean, and the outcome.

Your continuity is the PR. There is no session that persists between rounds:
prior review bodies, their outcomes, and the unresolved review threads are the
complete record, and your review body this round is what the next round gets.
Write it accordingly.

## The round

### 1. What you know coming in

```bash
gh pr view <N> --json number,title,body,state,headRefOid,baseRefName,author,isDraft,comments
git diff --stat "origin/<baseRefName>...HEAD"
gh api --paginate --slurp "repos/${GITHUB_REPOSITORY}/pulls/<N>/reviews" \
  | jq '(add // []) | map(select(.user.login == "claude[bot]") | {state, commit_id, body})'
```

(`gh pr diff` has no `--stat`; the checkout has full history, so plain git
gives the size picture. `--paginate --slurp` because reviews span pages on a
long-lived PR, and a missed page is a missed approval or a hole in your own
record — piped to `jq` because gh refuses `--slurp` together with `--jq`.)

If `state` is not `OPEN`, stop — post nothing. If the latest verdict-bearing (`APPROVED` / `CHANGES_REQUESTED`)
claude[bot] review is `APPROVED`, stop too — **unless** a commit since that review's
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
    reviewThreads(first:100){nodes{id isResolved path line comments(first:20){nodes{author{login} body}}}}}}}' \
  -f owner="${GITHUB_REPOSITORY%/*}" -f repo="${GITHUB_REPOSITORY#*/}" -F pr=<N>
```

Read every comment in a thread, not only the first: the replies are where
the work session says what it changed, and where a human names a ticket. The
PR's own comments (`comments` in the `gh pr view` call above) are where a
ticket gets named for a finding that had no thread. You cannot file a ticket
yourself, so these two places are the only way you learn that one exists.

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

Decide the outcome first:

- **REQUEST_CHANGES** — something should be fixed before merging.
- **APPROVE** — nothing blocks a merge. **This ends the review loop**: no
  further rounds run on this PR unless a human reopens it. Do not approve to
  be done; approve because you are done.
- **COMMENT** — nothing blocks a merge, but you raised things worth reading,
  or you want to see the next revision. Rounds continue.

Always write a body, including on approve — a silent approve is
indistinguishable from a crashed run. The body has three readers, in this
order: the human at the merge box, who needs the outcome and what remains
before anything else; the work session, which needs each finding and what to
do about it; and your next round, which needs to know what is still open.
The shape serves them in that order:

    Reviewed `<short sha>` at `<level>`. Round <n>. Outcome: <APPROVE|REQUEST_CHANGES|COMMENT>.

    Prior findings resolved: <resolved> of <carried in>.
    Remaining blocking: <count>.
    Remaining non-blocking: <count>.

    <Brief summary: a sentence or two on why this outcome. If it rests on
    less than a full check — suites you could not run, a fix you took on
    reading — say so here, not at the end.>

    ## Remaining blocking
    <Findings that must be fixed before merging. Or "None.">

    ## Remaining non-blocking
    <Findings worth acting on that do not hold the merge: a fix when the
    branch is next touched, or a ticket still to be filed. Or "None.">

    ## Closed
    <Prior findings this revision resolved or filed as a ticket, each saying
    how; and findings the engine raised that you are closing, each saying
    why. Or "None.">

    ## What ends this review
    <APPROVE: nothing, it is ended. COMMENT: what you want to see next.
    REQUEST_CHANGES: what must change.>

The first line is plain text — no blockquote or heading — with the short SHA
and level in backticks. The round is one more than the verdict-bearing (`APPROVED` /
`CHANGES_REQUESTED`) claude[bot] reviews already on the PR — a bodiless
`COMMENTED` review is a carrier for inline comments, not a round; on a re-review round write `Round <n> (re-review)`, so the
record shows the round was asked for, not that the approval gate failed.

"Carried in" is the number of items in the previous round's two Remaining
sections, and "resolved" is how many of them this revision fixed or filed as
a ticket. The prior body is the ledger for this line, not the review threads:
a finding on a line the diff doesn't touch never gets a thread, so the
threads undercount. Omit the line whenever nothing was carried in — round 1,
and any round after a body whose Remaining sections both read "None."

The two Remaining counts are the item counts of their sections, and the
outcome must agree with them: REQUEST_CHANGES exactly when remaining blocking
is non-zero. Remaining means work still open on this PR, not findings ever
raised: a non-blocking finding stays until it is fixed or has a ticket, and
once a ticket is named in a thread reply or a PR comment it moves to Closed
with the ticket as the how. An empty
section reads "None." rather than disappearing, so the sections are the same
every round and a search always lands.

Each finding is one item in exactly one section, opening with its
`path/to/file.ts:42` anchor and saying what is wrong, who notices, and the
next step. The section is the disposition: a finding that would carry two —
resolved, but leaving a residual worth a ticket — is two findings, one in
Closed and one in Remaining non-blocking. A finding outside these sections is
a decision handed back rather than made. "What ends this review" is the only
channel your next round has; write it for that reader.

Submit body and inline comments as **one review** (positions use the diff's
`line`/`side` addressing). `--jq '.html_url'` **prints** the submitted review's
URL: step 5's pointer needs it, and printing — rather than capturing to a shell
variable — is what carries it across to step 5's separate Bash call, where this
call's shell state no longer exists. Read the printed URL and substitute it into
step 5 as you would any `<placeholder>`. No URL printed means the POST didn't
land — a review you must not then bridge.

```bash
jq -n --arg body "$BODY" --arg sha "$HEAD_SHA" --argjson comments "$COMMENTS_JSON" \
  '{commit_id:$sha, event:"<APPROVE|REQUEST_CHANGES|COMMENT>", body:$body, comments:$comments}' \
| gh api "repos/${GITHUB_REPOSITORY}/pulls/<N>/reviews" --input - --jq '.html_url'
```

`comments` entries are `{path, line, side:"RIGHT", body}`. A finding on a line
the diff doesn't touch can't carry an inline comment — put it in the body with
its anchor instead.

### 5. Make sure the round reaches the work session

The formal review is the merge gate and your round-to-round ledger, but its
**body does not reach the work session**. The desktop "Auto-fix pull requests"
monitor relays inline review comments, issue comments, and CI failures into the
session that opened the PR — never a review's summary body (verified on
dotrequirements PR #341: an APPROVE whose only finding was in the body woke
nothing; an APPROVE carrying an inline comment relayed the *comment*, not the
body). Two outcomes therefore reach no one on their own: a finding that lives
only in the body (no inline comment of its own), which strands feedback; and a
clean APPROVE (no inline comments, no findings), which leaves the work session
waiting at the finish line — never told the loop closed and the PR is ready to
merge.

So post one issue comment — the outcome, the two counts, and a link to the
review — whenever the round would otherwise be silent:

- **the outcome is APPROVE** — the terminal state; the session should learn it
  can stop and merge, whether or not there were findings; or
- **any open finding is body-only** — one with no inline comment of its own (on
  a line the diff doesn't touch, or a round whose findings live wholly in the
  body). This test is per-finding: a review mixing an inline finding with a
  body-only one still posts, because only the inline one relays and the
  body-only one (which may be blocking) would otherwise be invisible.

Skip the comment only on a **non-approving** round whose every open finding
already has an inline comment — those already woke the session. The findings
stay in the review body, their single home; this comment is a pointer, not a
copy, so it is invisible to the workflow's approval gate and the assert step.

Post only for a review you saw submitted (step 4 printed its URL). The gate is
this prose, not a shell test — a count placeholder in `[ … ]` you forgot to fill
would be read as a redirection and swallow the call silently, the failure this
step exists to prevent, so there is none. Substitute `<N>`, the counts, and the
printed `<review url>` as everywhere else. The `<pointer>` phrase keys on the
counts: "Approved — nothing remaining, ready to merge" when both are zero,
otherwise "Findings are in the review":

```bash
gh api "repos/${GITHUB_REPOSITORY}/issues/<N>/comments" \
  -f body="Round <n>: <APPROVE|REQUEST_CHANGES|COMMENT> — <blocking> blocking, <non-blocking> non-blocking. <pointer>: <review url>"
```

### 6. Settle the threads

Unresolved review threads are the inline copy of the ledger; the ledger
itself is the prior body's Remaining sections, since a finding on a line the
diff doesn't touch has no thread. For each thread this revision addressed,
resolve it; if it attempted a fix that misses, reply in the thread saying
what's still wrong instead of resolving.

```bash
gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -f id=<THREAD_ID>
```

Resolve only what you verified fixed or saw filed as a ticket. An unresolved
thread is a standing claim; it should outlive any round that can't discharge
it.

## What you never do

- Write code, push commits, or edit files. Feedback reaches the work session
  through your review; revisions are its job.
- Approve a PR you authored a fix for. You didn't — you can't push — but if a
  round somehow finds claude[bot] commits on the branch, say so in the body
  and use COMMENT, not APPROVE.
- Evaluate the engine. If a class of issue is being missed, the fix is a
  CLAUDE.md rule (the engine reads them), not commentary on the reviewer.
