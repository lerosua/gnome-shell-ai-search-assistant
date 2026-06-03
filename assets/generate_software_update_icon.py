#!/usr/bin/env python3
from math import cos, radians, sin
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


SIZE = 1024
SCALE = 3
S = SIZE * SCALE
OUT = Path(__file__).with_name("apple-software-update.png")


def sc(value):
    return int(round(value * SCALE))


def lerp(a, b, t):
    return int(a + (b - a) * t)


def draw_gradient(size):
    width, height = size
    c1 = (132, 220, 255)
    c2 = (30, 139, 255)
    c3 = (46, 202, 128)
    c4 = (11, 139, 92)
    img = Image.new("RGBA", size)
    px = img.load()

    for y in range(height):
        for x in range(width):
            t = (x * 0.44 + y * 0.56) / (width * 0.44 + height * 0.56)
            if t < 0.38:
                p = t / 0.38
                color = tuple(lerp(c1[i], c2[i], p) for i in range(3))
            elif t < 0.72:
                p = (t - 0.38) / 0.34
                color = tuple(lerp(c2[i], c3[i], p) for i in range(3))
            else:
                p = (t - 0.72) / 0.28
                color = tuple(lerp(c3[i], c4[i], p) for i in range(3))
            px[x, y] = (*color, 255)

    return img


def rounded_rect_mask(size, box, radius):
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle(box, radius=radius, fill=255)
    return mask


def polygon_points(cx, cy, radii, teeth, offset=-90):
    points = []
    for i in range(teeth * 2):
        angle = radians(offset + i * 180 / teeth)
        radius = radii[0] if i % 2 == 0 else radii[1]
        points.append((cx + cos(angle) * radius, cy + sin(angle) * radius))
    return points


def arc_points(cx, cy, radius, start, end, steps=96):
    if end < start:
        end += 360
    return [
        (
            cx + cos(radians(start + (end - start) * i / steps)) * radius,
            cy + sin(radians(start + (end - start) * i / steps)) * radius,
        )
        for i in range(steps + 1)
    ]


def draw_arrow(draw, cx, cy, radius, start, end, width, color):
    pts = arc_points(cx, cy, radius, start, end, steps=8)
    box = (cx - radius, cy - radius, cx + radius, cy + radius)
    draw.arc(box, start=start, end=end, fill=color, width=width)

    for x, y in (pts[0], pts[-1]):
        draw.ellipse(
            (x - width / 2, y - width / 2, x + width / 2, y + width / 2),
            fill=color,
        )

    angle = radians(end + 90)
    tip = pts[-1]
    head_len = width * 1.35
    side = width * 0.82
    back = (tip[0] - cos(angle) * head_len, tip[1] - sin(angle) * head_len)
    normal = (-sin(angle), cos(angle))
    arrow = [
        tip,
        (back[0] + normal[0] * side, back[1] + normal[1] * side),
        (back[0] - normal[0] * side, back[1] - normal[1] * side),
    ]
    draw.polygon(arrow, fill=color)


def main():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    bg_box = (sc(92), sc(92), sc(932), sc(932))
    bg_radius = sc(198)

    shadow_mask = rounded_rect_mask((S, S), bg_box, bg_radius)
    shadow = Image.new("RGBA", (S, S), (0, 58, 96, 0))
    shadow.putalpha(shadow_mask.filter(ImageFilter.GaussianBlur(sc(34))))
    shadow = shadow.transform((S, S), Image.Transform.AFFINE, (1, 0, 0, 0, 1, sc(30)))
    img.alpha_composite(shadow)

    gradient = draw_gradient((S, S))
    mask = rounded_rect_mask((S, S), bg_box, bg_radius)
    icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    icon.alpha_composite(gradient)
    icon.putalpha(mask)
    img.alpha_composite(icon)

    overlay = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    od.rounded_rectangle(
        (sc(110), sc(110), sc(914), sc(914)),
        radius=sc(184),
        outline=(255, 255, 255, 82),
        width=sc(10),
    )
    od.ellipse((sc(142), sc(62), sc(782), sc(538)), fill=(255, 255, 255, 64))
    od.rectangle((sc(90), sc(438), sc(934), sc(934)), fill=(255, 255, 255, 0))
    overlay.putalpha(Image.composite(overlay.getchannel("A"), Image.new("L", (S, S), 0), mask))
    img.alpha_composite(overlay)

    symbol = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    sd = ImageDraw.Draw(symbol)
    cx = cy = sc(512)
    white = (255, 255, 255, 238)

    soft = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    softd = ImageDraw.Draw(soft)
    draw_arrow(softd, cx, cy, sc(252), -138, 22, sc(56), (0, 54, 84, 66))
    draw_arrow(softd, cx, cy, sc(252), 42, 202, sc(56), (0, 54, 84, 66))
    soft = soft.filter(ImageFilter.GaussianBlur(sc(6)))
    symbol.alpha_composite(soft)

    draw_arrow(sd, cx, cy, sc(252), -138, 22, sc(54), white)
    draw_arrow(sd, cx, cy, sc(252), 42, 202, sc(54), white)

    gear_shadow = polygon_points(cx, cy, (sc(164), sc(134)), 12)
    sd.polygon([(x, y + sc(12)) for x, y in gear_shadow], fill=(0, 58, 94, 70))
    sd.polygon(polygon_points(cx, cy, (sc(164), sc(134)), 12), fill=(255, 255, 255, 246))
    sd.ellipse((cx - sc(96), cy - sc(96), cx + sc(96), cy + sc(96)), fill=(255, 255, 255, 246))
    sd.ellipse((cx - sc(53), cy - sc(53), cx + sc(53), cy + sc(53)), fill=(32, 146, 238, 255))
    sd.ellipse((cx - sc(34), cy - sc(34), cx + sc(34), cy + sc(34)), fill=(22, 117, 216, 255))

    img.alpha_composite(symbol)

    final = img.resize((SIZE, SIZE), Image.Resampling.LANCZOS)
    final.save(OUT)


if __name__ == "__main__":
    main()
