# Contributing to LifeContext

Issues and pull requests are welcome on this repository.

## How a contribution reaches the project

Day-to-day development happens in a private repository; this one receives reviewed snapshots on a
weekly/monthly cadence — see the README's "How this repository is maintained" section for why. In
practice that means:

- **An issue you open here is a community report.** It's triaged into the private tracker, so a fix
  may land in a later public snapshot rather than as a direct commit against your report. If you
  see a bare `#<n>` referenced in a commit message or code comment elsewhere in this repo, that
  number is the private tracker's — it predates this repo's public existence and won't resolve to
  anything visible here.
- **A pull request you open here isn't merged directly.** It's reviewed and, if accepted, its
  change is carried into the private repo and reaches this one again in a later snapshot. Don't be
  surprised if your PR is closed with a pointer to the snapshot that includes the change rather than
  a merge commit of the PR itself.
- There's no special local tooling required to contribute. Clone the repo, follow the Quickstart in
  `README.md`, and match the style of the file you're editing.

## Before you invest time in a PR

For anything beyond a small, obvious fix, open an issue first describing the problem and your
proposed approach. Given the round trip through the private repo above, that's the same courtesy
any maintainer-facing project asks for — it avoids a PR that's already been superseded by
in-progress private work, or an approach the maintainer would ask you to change anyway.
