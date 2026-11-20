# Cross-deployment concerns

Nothing in the code is tied to a specific Domino deployment. The two things most likely to break on another deployment are below.

## 1. Workspaces need Python 3.11, but the README says any Python 3

`herdr-workspace.sh` installs Herdr using `hashlib.file_digest`, which only exists in Python 3.11 and later. The README's workspace SSH section asks only for "Python 3 with `requests`". Many Domino Standard Environments ship Python 3.9 or 3.10, and on those the Herdr install fails with an `AttributeError`.

Fix: replace it with `hashlib.sha256(candidate.read_bytes()).hexdigest()`, which works on Python 3.9. No other workspace-side code needs 3.11.

## 2. Reliance on internal Domino APIs and pages

The App uses undocumented endpoints that could change between Domino versions:

- `/v4/...`
- `/domino-connect/api/v1/workspaces/.../ssh-diagnose`
- `notebookPublicUrl`
- the `workspaceSshEnabled` flag from `/v4/auth/principal`

To save Codex and Claude Code sign-in, it also scrapes the HTML of the `/account` page and posts to its forms. These exist on recent Domino 6.x but likely not on older releases. If the account page can't be parsed, the App falls back to asking users to set the variables themselves.

Suggestion: state the Domino version this was tested on in the README so people on other versions know what to expect.
