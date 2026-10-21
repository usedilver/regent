from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


repo = Path(__file__).resolve().parent.parent
source = repo / "client-plugin"
output = repo / "tmp" / "talently-code-plugin.zip"
files = {
    ".claude-plugin/plugin.json": source / ".claude-plugin/plugin.json",
    ".mcp.json": source / ".mcp.json",
    "skills/talently-code/SKILL.md": source / "skills/talently-code/SKILL.md",
    "README.md": source / "README.md",
    "LICENSE": repo / "LICENSE",
}
contents = {name: file.read_bytes() for name, file in files.items()}
output.parent.mkdir(parents=True, exist_ok=True)
with ZipFile(output, "w", compression=ZIP_DEFLATED) as archive:
    for name, content in contents.items():
        entry = ZipInfo(f"talently-code/{name}")
        entry.compress_type = ZIP_DEFLATED
        entry.external_attr = 0o100644 << 16
        archive.writestr(entry, content)
print(output)
