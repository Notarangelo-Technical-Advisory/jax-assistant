# LinkedIn Tuesday Posts

MAISIE helps Jack publish one LinkedIn post every Tuesday for Notarangelo Technical Advisory. Jack posts it himself; MAISIE drafts, asks for approval, reminds him, and keeps the queue up to date.

## Where everything is

- **Queue, drafts and writing rules** are in `Notarangelo-Technical-Advisory/fractional-tech-advisory`, on `main`:
  - `operations/marketing/linkedin-queue.md`: one row per Tuesday, with a Status column (`idea`, `drafted`, `approved`, `posted`).
  - `operations/marketing/linkedin-posts/`: one draft per post, named by date.
  - `operations/skills/marketing-linkedin/SKILL.md`: the writing rules.
- **MAISIE's code** is `functions/src/linkedin.ts`. It reads and writes those files through the GitHub API, so the repository is the only record and Jack can still edit the files by hand.
- **Firestore** holds only `linkedin/week`, the dashboard card. The card shows the coming Tuesday, unless that post is already posted; then it shows the next Tuesday that is not posted.

## Every week (all times ET)

- **Every day, 6:30 AM** (`linkedinRefresh`): reloads the card from GitHub, so hand edits show up.
- **Thursday, 9:00 AM** (`linkedinDraft`): if next Tuesday's row says `idea`, MAISIE writes the draft with the skill, saves it, and marks it `drafted`.
- **Friday, 9:00 AM** (`linkedinApprovalRequest`): texts Jack to approve the draft, unless it is already approved.
- **Tuesday, 7:45 AM** (`linkedinPostReminder`): texts Jack.
  - If the post is approved, the card shows it with Copy buttons.
  - If nothing is approved, the text says to post nothing.
- **When Jack posts**, he presses "I posted it", and can add the link. The row becomes `posted`.

## How Jack acts

- **On the dashboard's LinkedIn card:** Copy post, Copy first comment, Approve, Ask for changes, I posted it, and Draft it now for an idea.
- **In chat or by text:** "Show me Tuesday's LinkedIn post", "I approve the Sep 29 post", "Change the first line of the Oct 6 post to …", "I posted it".

## Jack's rules, and where the code enforces them

- **Never post without approval.** Only an `approved` post can become `posted`. MAISIE never publishes to LinkedIn.
- **Never change the words of an approved post.** Revising an approved post first resets it to `drafted`, so Jack must approve it again.
- **Never approve a post with a placeholder** such as `[STORY: ...]`. The Approve button is disabled, and the action is refused.
- **Never invent facts.** The drafting prompt is the skill itself, plus the rule to leave a placeholder where a fact is missing.
- **Fewer than 4 topics left.** When fewer than 4 `idea` or `drafted` rows remain, the card and the texts say so.
- **Hand edits are never overwritten.** Every write sends the version it read, and GitHub refuses the write if the file changed in the meantime.
- **The queue is written first.** If a second write fails, the queue is still correct.

## Setup

- **GitHub secret `LINKEDIN_QUEUE_PAT`** in `jax-assistant`: a fine-grained token with access only to `fractional-tech-advisory`, with the Contents permission set to Read and write.
- **Text messages** use the existing Twilio settings. Sending a text first is new for MAISIE, which until now only replied to Jack's texts. If the Twilio number is not allowed to start messages, the texts fail and are logged. The card still works.

## Not included

- **Publishing through the LinkedIn API.** Jack chose to post himself. Publishing through the API would need a LinkedIn developer app approved for posting, and a new login about every 60 days.
