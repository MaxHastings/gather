"""Maintenance only: index every bundled EmojiTwo asset, without a runtime dependency."""
import json, unicodedata
from pathlib import Path
source = json.loads(Path('.gather-test-emojitwo/emoji.json').read_text(encoding='utf-8'))
index = json.loads(Path('src/assets/emoji-index.json').read_text(encoding='utf-8'))
def normalize(code): return '-'.join(format(int(p,16),'x') for p in code.split('-') if int(p,16) != 0xfe0f)
lookup = {}
for code, entry in source.items():
    for value in [code, *[v for k,v in entry['code_points'].items() if k != 'decimal']]:
        lookup[normalize(value)] = entry
entries = []
fallbacks = 0
for code in index:
    points = [int(p,16) for p in code.split('-')]
    normalized = normalize(code)
    entry = lookup.get(normalized)
    base = '-'.join(format(p,'x') for p in points if p != 0xfe0f and not 0x1f3fb <= p <= 0x1f3ff)
    parent = lookup.get(base)
    if not entry: fallbacks += 1
    name = entry['name'] if entry else ' '.join(unicodedata.name(chr(p),format(p,'x')).lower().replace('regional indicator symbol letter ', '') for p in points if p not in [0x200d,0xfe0f])
    if not entry and parent:
        name = parent['name'] + ' ' + ', '.join(['light skin tone','medium light skin tone','medium skin tone','medium dark skin tone','dark skin tone'][p-0x1f3fb] for p in points if 0x1f3fb <= p <= 0x1f3ff)
    category = (entry or parent or {}).get('category') or 'other'
    keywords = ' '.join([name, (entry or parent or {}).get('shortname',''), * (entry or parent or {}).get('keywords',[]), * (entry or parent or {}).get('shortname_alternates',[])])
    entries.append(dict(code=code,value=''.join(chr(p) for p in points),name=name,category=category,keywords=keywords,order=int((entry or parent or {}).get('emoji_order') or 99999)))
entries.sort(key=lambda e:(e['order'],e['code']))
for entry in entries: del entry['order']
Path('src/assets/emoji-catalog.json').write_text(json.dumps(entries,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
print(f'Catalogued all {len(entries)} EmojiTwo assets; {fallbacks} newer sequences use descriptive Unicode names or base names.')
