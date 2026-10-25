from PIL import Image, ImageDraw
from pathlib import Path

root = Path(__file__).resolve().parent.parent
image = Image.new('RGBA', (512, 512), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((12, 12, 500, 500), 154, fill='#079bdb')
draw.rounded_rectangle((100, 112, 412, 366), 118, fill='white')
draw.polygon([(115, 296), (119, 416), (214, 353)], fill='white')
draw.ellipse((185, 226, 211, 252), fill='#079bdb')
draw.ellipse((285, 226, 311, 252), fill='#079bdb')
image.save(root / 'electron' / 'icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
image.save(root / 'electron' / 'icon.png')
image.save(root / 'electron' / 'icon.icns')
