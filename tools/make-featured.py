"""Build store/featured.png (1800x1200, the Plugin Center's 3:2 featured image) from the
icon and the Results cover. Needs Pillow; fonts come from the Windows font folder."""
import os
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
STORE = ROOT / 'store'
FONTS = Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Fonts'

W, H = 1800, 1200
LEFT = 150

# brand gradient from the icon (#4f7cff -> #9b5cf6), top-left to bottom-right
vertical = Image.linear_gradient('L')
mask = ImageChops.add(vertical, vertical.transpose(Image.TRANSPOSE), scale=2).resize((W, H), Image.BICUBIC)
canvas = Image.composite(Image.new('RGB', (W, H), '#9b5cf6'), Image.new('RGB', (W, H), '#4f7cff'), mask)

# header: icon, name, one-line pitch
icon = Image.open(STORE / 'icon-512.png').convert('RGBA').resize((140, 140), Image.LANCZOS)
canvas.paste(icon, (LEFT - 12, 84), icon)
draw = ImageDraw.Draw(canvas)
title = ImageFont.truetype(str(FONTS / 'seguisb.ttf'), 78)
pitch = ImageFont.truetype(str(FONTS / 'segoeui.ttf'), 36)
draw.text((LEFT + 150, 88), 'Video Duplicate Finder', font=title, fill='#ffffff')
draw.text((LEFT + 154, 188), 'Find duplicate and near-duplicate videos in your Eagle library',
          font=pitch, fill=(255, 255, 255, 230))

# screenshot, running off the bottom edge, with rounded corners and a soft shadow
shot = Image.open(STORE / 'cover-1-results.png').convert('RGB')
sw = W - 2 * LEFT
shot = shot.resize((sw, round(shot.height * sw / shot.width)), Image.LANCZOS)
top = 316
radius = 22

shadow = Image.new('L', (W, H), 0)
ImageDraw.Draw(shadow).rounded_rectangle((LEFT, top + 14, LEFT + sw, top + shot.height + 14), radius, fill=150)
shadow = shadow.filter(ImageFilter.GaussianBlur(28))
canvas = Image.composite(Image.new('RGB', (W, H), '#1b1446'), canvas, shadow)

corners = Image.new('L', shot.size, 0)
ImageDraw.Draw(corners).rounded_rectangle((0, 0, shot.width - 1, shot.height - 1), radius, fill=255)
canvas.paste(shot, (LEFT, top), corners)

out = STORE / 'featured.png'
canvas.save(out, optimize=True)
print(out, canvas.size, out.stat().st_size)
