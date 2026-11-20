"""Codex and Claude Code sign-in kept in the App owner's Domino user environment variables.

Domino has no JSON API for user environment variables. Its account page lists them and
changes them through form posts, which accept the App's Domino bearer token. Domino
answers those posts with a redirect whether or not they succeed, so callers confirm
each change by reading the account page again.
"""

import base64
import binascii
import json
import re
from datetime import date, timedelta
from html.parser import HTMLParser

ACCOUNT_PAGE = "/account"
SET_VARIABLE = "/account/setUserEnvironmentVariable"
UNSET_VARIABLE = "/account/unsetUserEnvironmentVariable"
ACCOUNT_SECTION = "/account#user-variables"
MAX_VALUE = 30_000
# `claude setup-token` issues tokens that last about a year.
CLAUDE_TOKEN_DAYS = 365
RENEW_WARNING_DAYS = 30

PROVIDERS = {
    "claude": {"name": "Claude Code", "variable": "CLAUDE_CODE_OAUTH_TOKEN"},
    "codex": {"name": "Codex", "variable": "CODEX_AUTH_JSON_B64"},
}

SAVED = re.compile(r"Saved by Workspace Sessions on (\d{4}-\d{2}-\d{2})")
CLAUDE_TOKEN = re.compile(r"sk-ant-oat\d+-[A-Za-z0-9_-]{20,}")
TOKEN_TEXT = re.compile(r"[A-Za-z0-9_-]+")


class AccountPage(HTMLParser):
    """User environment variables, plus what's needed to change them, from Domino's account page."""

    def __init__(self, html):
        super().__init__(convert_charrefs=True)
        self.csrf = None
        self.listed = False
        self.writable = False
        self.variables = {}
        self._depth = 0
        self._row = None
        self._cell = None
        self.feed(html)
        self.close()

    @property
    def readable(self):
        # Domino leaves out the table when no variables are set.
        return self.listed or self.writable

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == "input" and attributes.get("name") == "csrfToken" and not self.csrf:
            self.csrf = attributes.get("value")
        elif tag == "form" and attributes.get("id") == "setUserEnvironmentVariableForm":
            self.writable = True
        if self._depth:
            if tag == "div":
                self._depth += 1
            elif tag == "tr":
                self._row = []
            elif tag == "td" and self._row is not None:
                self._cell = []
                self._row.append(self._cell)
        elif tag == "div" and attributes.get("id") == "user-env-var-table":
            self.listed = True
            self._depth = 1

    def handle_endtag(self, tag):
        if not self._depth:
            return
        if tag == "div":
            self._depth -= 1
        elif tag == "td":
            self._cell = None
        elif tag == "tr" and self._row is not None:
            cells = ["".join(cell).strip() for cell in self._row]
            if len(cells) >= 2 and cells[0]:
                self.variables[cells[0]] = {"value": cells[1], "description": cells[2] if len(cells) > 2 else ""}
            self._row = None

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)


def saved_description(today=None):
    return f"Saved by Workspace Sessions on {(today or date.today()).isoformat()}"


def saved_on(description):
    match = SAVED.search(description or "")
    if not match:
        return None
    try:
        return date.fromisoformat(match[1])
    except ValueError:
        return None


def normalize_claude(text):
    """Return the token from pasted `claude setup-token` output.

    Terminals wrap the long token across lines, so continuation lines are joined back on.
    """
    if not isinstance(text, str) or not text.strip():
        raise ValueError("Paste the token that claude setup-token printed.")
    if len(text) > MAX_VALUE:
        raise ValueError("That’s too long for a Claude Code token. Paste only the token.")
    lines = [line.strip() for line in text.strip().splitlines()]
    for index, line in enumerate(lines):
        start = line.find("sk-ant-oat")
        if start < 0:
            continue
        token = line[start:]
        for following in lines[index + 1:]:
            if not TOKEN_TEXT.fullmatch(following):
                break
            token += following
        token = token.strip("'\"")
        if CLAUDE_TOKEN.fullmatch(token):
            return token
        break
    if "sk-ant-api" in text:
        raise ValueError("That’s an Anthropic API key. Paste the token from claude setup-token, which starts with sk-ant-oat.")
    raise ValueError("That doesn’t look like a Claude Code token. Copy the whole token that claude setup-token printed. It starts with sk-ant-oat.")


def decode_codex(value):
    """Decode a stored or pasted Codex login. Accepts base64 or the auth.json text itself."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Paste the text the Codex command copied.")
    if len(value) > MAX_VALUE:
        raise ValueError("That’s too long for a Codex login. Run the command again and paste the new result.")
    text = value.strip()
    if text.startswith("{"):
        contents = text.encode()
    else:
        compact = "".join(text.split())
        try:
            contents = base64.b64decode(compact, validate=True)
        except (binascii.Error, ValueError):
            raise ValueError("That doesn’t look like a Codex login. Run the command again, then paste with ⌘V.") from None
    try:
        auth = json.loads(contents)
    except ValueError:
        raise ValueError("That doesn’t look like a Codex login. Run the command again, then paste with ⌘V.") from None
    tokens = auth.get("tokens") if isinstance(auth, dict) else None
    signed_in = isinstance(tokens, dict) and bool(tokens.get("refresh_token"))
    if not isinstance(auth, dict) or not (signed_in or auth.get("OPENAI_API_KEY")):
        raise ValueError("This Codex login has no sign-in tokens. Run the command again and finish signing in.")
    return contents, auth


def normalize_codex(text):
    contents, _ = decode_codex(text)
    return base64.b64encode(contents).decode()


NORMALIZE = {"claude": normalize_claude, "codex": normalize_codex}


def codex_account(auth):
    """The account and plan shown for a Codex login. Never includes tokens."""
    tokens = auth.get("tokens") if isinstance(auth.get("tokens"), dict) else {}
    if auth.get("OPENAI_API_KEY") and not tokens:
        return {"account": "OpenAI API key"}
    token = tokens.get("id_token") if isinstance(tokens.get("id_token"), str) else ""
    token = token.split(".")
    if len(token) != 3:
        return {}
    try:
        claims = json.loads(base64.urlsafe_b64decode(token[1] + "=" * (-len(token[1]) % 4)))
    except (binascii.Error, ValueError):
        return {}
    if not isinstance(claims, dict):
        return {}
    summary = {}
    if isinstance(claims.get("email"), str):
        summary["account"] = claims["email"][:200]
    openai = claims.get("https://api.openai.com/auth")
    plan = openai.get("chatgpt_plan_type") if isinstance(openai, dict) else None
    if isinstance(plan, str) and plan:
        summary["plan"] = plan[:40]
    return summary


def provider_status(provider, entry, today=None):
    """Summarize one provider's saved sign-in for the browser. Never includes the secret."""
    if not entry or not entry.get("value"):
        return {"state": "missing"}
    status = {"state": "ok"}
    saved = saved_on(entry.get("description"))
    if saved:
        status["savedAt"] = saved.isoformat()
    try:
        if provider == "codex":
            status.update(codex_account(decode_codex(entry["value"])[1]))
        else:
            normalize_claude(entry["value"])
    except ValueError:
        return {**status, "state": "invalid"}
    if provider == "claude" and saved:
        expires = saved + timedelta(days=CLAUDE_TOKEN_DAYS)
        status["expiresAt"] = expires.isoformat()
        today = today or date.today()
        if today >= expires:
            status["state"] = "expired"
        elif today >= expires - timedelta(days=RENEW_WARNING_DAYS):
            status["state"] = "expiring"
    return status


def stored_value(provider, page):
    """The saved value to hand to a workspace, '' when none is saved, or None when it can't be used."""
    entry = page.variables.get(PROVIDERS[provider]["variable"])
    if not entry or not entry.get("value"):
        return ""
    try:
        return NORMALIZE[provider](entry["value"])
    except ValueError:
        return None
