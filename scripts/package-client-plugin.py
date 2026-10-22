import argparse
import json
from pathlib import Path
from urllib.parse import urlsplit
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


parser = argparse.ArgumentParser(description="Package the client with an explicit public MCP endpoint.")
parser.add_argument("--endpoint", required=True, help="Public HTTPS /mcp URL of an OAuth-enabled instance")
parser.add_argument("--output", type=Path, help="ZIP destination (defaults to tmp/talently-code-plugin.zip)")
args = parser.parse_args()
try:
    endpoint = urlsplit(args.endpoint)
    port = endpoint.port
except ValueError:
    parser.error("--endpoint must be a valid public HTTPS /mcp URL")
if (endpoint.scheme != "https" or not endpoint.hostname
        or (port is not None and port < 1)
        or endpoint.hostname.lower().rstrip(".") in {"localhost", "127.0.0.1", "::1"}
        or endpoint.username is not None or endpoint.password is not None
        or endpoint.path != "/mcp" or endpoint.query or endpoint.fragment
        or any(character.isspace() for character in args.endpoint)
        or any(character in args.endpoint for character in "${}\\")):
    parser.error("--endpoint requires a literal public HTTPS /mcp URL without credentials, query or fragment")

repo = Path(__file__).resolve().parent.parent
source = repo / "client-plugin"
output = args.output or repo / "tmp" / "talently-code-plugin.zip"
files = {
    ".claude-plugin/plugin.json": source / ".claude-plugin/plugin.json",
    "skills/talently-code/SKILL.md": source / "skills/talently-code/SKILL.md",
    "README.md": source / "README.md",
    "LICENSE": repo / "LICENSE",
}
contents = {name: file.read_bytes() for name, file in files.items()}
contents[".mcp.json"] = (json.dumps({"mcpServers": {"talently-code": {
    "type": "http", "url": args.endpoint,
}}}, indent=2) + "\n").encode()
output.parent.mkdir(parents=True, exist_ok=True)
with ZipFile(output, "w", compression=ZIP_DEFLATED) as archive:
    for name, content in contents.items():
        entry = ZipInfo(f"talently-code/{name}")
        entry.compress_type = ZIP_DEFLATED
        entry.external_attr = 0o100644 << 16
        archive.writestr(entry, content)
print(output)
