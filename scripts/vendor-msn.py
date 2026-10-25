"""Maintenance only. Run against the pinned upstream checkout with Pillow."""
from pathlib import Path
from PIL import Image
import base64, io, json, re
source = Path('.gather-test-msn')
entries = []
for line in (source / 'README.md').read_text(encoding='utf-8').splitlines():
    if not line.startswith('| !['): continue
    parts = re.split(r'(?<!\\)\|', line)
    match = re.search(r'`([a-z][a-z-]+)`', line)
    if not match: continue
    name = match.group(1)
    path = source / 'original' / (name + '.png')
    if not path.exists(): path = source / 'retro' / (name + '.png')
    image = Image.open(path)
    poster = io.BytesIO()
    image.seek(0)
    image.convert('RGBA').save(poster, format='PNG')
    shortcut = parts[3].strip().strip('`').replace('\\|', '|')
    if shortcut == name: shortcut = ''
    entries.append(dict(id=name, name=parts[2].strip().replace('[^1]', ''), shortcut=shortcut,
        animated=getattr(image, 'n_frames', 1) > 1,
        data='data:image/png;base64,' + base64.b64encode(path.read_bytes()).decode(),
        poster='data:image/png;base64,' + base64.b64encode(poster.getvalue()).decode()))
Path('src/assets/msn-emoticons.json').write_text(json.dumps(entries, separators=(',', ':')), encoding='utf-8')
ids = [entry['id'] for entry in entries]
Path('server/msn-policy.mjs').write_text('const ids = new Set(' + json.dumps(ids) + ');\nexport const isMsnToken = value => typeof value === "string" && value.startsWith(":msn-") && value.endsWith(":") && ids.has(value.slice(5,-1));\n', encoding='utf-8')
print(f'Bundled {len(entries)} classic MSN assets with still posters; no upstream code.')
