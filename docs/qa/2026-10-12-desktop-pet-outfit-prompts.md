# 司命朱红常服：生成提示词

日期：2026-10-12。使用内置 image_gen，不使用 CLI/API 生图。
所有输出保留原始 RGBA PNG；运行时只等比登记、眼区羽化，不脚本裁切或改写原图。原衣装不覆盖。

输入：当前 `frontend/public/desktop-pet/poses/` 五种动作；站姿另参考 `docs/images/characters/siming_chibi_character_sheet_v1.png`。新站姿成为其余四个动作的服装参考；眨眼帧只参考各自的新睁眼原图。
正式保存：`frontend/public/desktop-pet/poses/casual-{standing,reading,peeking,dozing,picked-up}.png`；除 dozing 外各增加 `-half.png` 与 `-closed.png`。全部 SHA-256 记录在唯一素材 manifest。

## standing

```text
Use case: identity-preserve.
Asset type: one complete transparent RGBA sprite, second outfit for the existing Siming desktop pet.
Input images: Image 1 is the exact standing pose/composition/character to edit. Image 2 is a high-resolution identity and drawing-style reference only, not a layout to copy.
Primary request: Change ONLY the outfit into a lighter everyday companion outfit in the SAME existing ivory, muted cinnabar red, charcoal and antique-gold palette. An ivory waist-length open Chinese-style short jacket with restrained red/gold edge embroidery, neat narrow long sleeves with small charcoal cuffs ending exactly at the wrists; charcoal high collar inner top with tiny antique-gold fastenings; muted cinnabar high-waisted pleated midi skirt just above the same short black gold-trim boots, a simple charcoal waistband. Keep the same round ivory/red waist pendant, but appropriately scaled and hung from the waistband. This should read as a distinct second costume, not the original floor-length open robe. No long split apron front or enormous hanging sleeves.
Invariants: Keep the EXACT same character identity, face, warm brown eyes, gentle closed-mouth expression, head-to-body ratio, long dark hair with deep red inner lengths, hairstyle, earrings, full-body frontal standing pose, foot spacing, arm and hand locations, and single closed brown/gold book held vertically at chest. Do not make her taller, older or slimmer. Both hands stay anatomically correct and in contact with the book. Clean integrated sleeves, wrists, shoulders, waist and neck: no layer gaps or extra arms. Match the original delicate warm anime linework and soft shading. Use Image 1 placement and whitespace proportions. Single character, full hair and boots, no crop, no extra props, no text, no sheet, no labels, no logo or watermark.
Output: portrait 2:3 canvas; genuinely transparent alpha background, including between hair strands and around clothing; no scene, no floor, no shadow outside the silhouette, no glow/halo, no painted checkerboard. White clothing, skin and eye whites remain opaque.
```

## reading

```text
Use case: identity-preserve.
Asset type: one complete transparent RGBA desktop pet character sprite, outfit 02, reading action.
Input images: Image 1 is the exact POSE, expression, proportions and composition to edit. Image 2 is the canonical SECOND OUTFIT and character drawing reference. Transfer the clothing of Image 2 onto Image 1, do not copy Image 2's standing posture.
Primary request: Retain Image 1's three-quarter standing reading pose exactly: head slightly bowed and turned toward the open book, both eyes looking at the pages, exactly two hands supporting the SAME open brown book with its cream pages and gold cover mark. Same relaxed closed mouth. Both boots planted, body and hair complete.
Outfit contract: EXACT same second outfit as Image 2: ivory waist-length open short Chinese-style jacket with modest bell sleeve ends and black gold-lined cuffs, red knotted fastenings and gold edge embroidery, charcoal high-collar inner top, cinnabar pleated midi skirt with restrained gold embroidery at hem and narrow charcoal/gold accent panel, charcoal waistband, same single round ivory/red waist pendant, same short black gold-trim boots. No original long white outer robe or huge hanging sleeves.
Invariants: Same Siming chibi woman, warm brown eyes, small gentle face, fair skin, long dark hair with deep-red inner lengths, half-up hairstyle, same gold hairpin and red tassel earrings; approximately 2.7 heads tall. Keep Image 1 pose/face angle/expression/head-size/body-scale/hand locations/book orientation. Hands join sleeves cleanly and grip the book naturally; exactly two arms and hands, no holes, detached wrists, duplicate body parts, elongated neck, or overlap artifacts. The changed clothes must adapt naturally to the pose without changing its meaning.
Style: match Image 2's delicate warm anime linework, crisp edges and soft shading. Single complete character on portrait 2:3 canvas, roomy transparent margin, no crop. Genuine transparent alpha, NO glow or shadow outside character, no floor or background, no checkerboard, no text/labels/watermark, no extra props. Keep ivory clothes, pages, skin and eye whites opaque.
```

## peeking

```text
Use case: identity-preserve.
Asset type: one complete transparent RGBA desktop pet character sprite, outfit 02, peeking action.
Input images: Image 1 is the exact POSE, expression, proportions and composition to edit. Image 2 is the canonical SECOND OUTFIT and character drawing reference. Transfer the clothing of Image 2 onto Image 1, do not copy Image 2's standing posture.
Primary request: Retain Image 1's diagonal full-body peeking pose exactly: torso and head lean toward the viewer's right, eyes look gently out toward the right, small closed smile; one hand by collar/cheek, the other hugs the single closed brown book to the chest. Both legs and boots remain in the image to the left, long hair complete. This is the complete leaning character BEFORE screen-edge clipping. Do NOT draw a wall, screen edge, partition, crop, or cut away any of the character.
Outfit contract: EXACT same second outfit as Image 2: ivory waist-length open short Chinese-style jacket with modest bell sleeve ends and black gold-lined cuffs, red knotted fastenings and gold edge embroidery, charcoal high-collar inner top, cinnabar pleated midi skirt with restrained gold embroidery at hem and narrow charcoal/gold accent panel, charcoal waistband, same single round ivory/red waist pendant, same short black gold-trim boots. No original long white outer robe or huge hanging sleeves.
Invariants: Same Siming chibi woman, warm brown eyes, small gentle face, fair skin, long dark hair with deep-red inner lengths, half-up hairstyle, same gold hairpin and red tassel earrings; approximately 2.7 heads tall. Keep Image 1 pose/face angle/expression/head-size/body-scale/hand locations/book orientation. Hands join sleeves cleanly and grip the book naturally; exactly two arms and hands, no holes, detached wrists, duplicate body parts, elongated neck, or overlap artifacts. The changed clothes must adapt naturally to the pose without changing its meaning.
Style: match Image 2's delicate warm anime linework, crisp edges and soft shading. Single complete character on portrait 2:3 canvas, roomy transparent margin, no crop. Genuine transparent alpha, NO glow or shadow outside character, no floor or background, no checkerboard, no text/labels/watermark, no extra props. Keep ivory clothes, pages, skin and eye whites opaque.
```

## dozing

```text
Use case: identity-preserve.
Asset type: one complete transparent RGBA desktop pet character sprite, outfit 02, dozing action.
Input images: Image 1 is the exact POSE, expression, proportions and composition to edit. Image 2 is the canonical SECOND OUTFIT and character drawing reference. Transfer the clothing of Image 2 onto Image 1, do not copy Image 2's standing posture.
Primary request: Retain Image 1's clearly seated curled-up dozing pose exactly: legs folded loosely to one side, both boots visible, cheek resting on folded forearms above the normal sized closed brown book on her lap, peacefully closed eyes. Short jacket sleeves rest naturally on the book; cinnabar pleated skirt spreads and folds naturally over bent knees. Full long hair gathered on either side. Compact low silhouette with same head scale, not a standing figure, no furniture/pillow or extra book.
Outfit contract: EXACT same second outfit as Image 2: ivory waist-length open short Chinese-style jacket with modest bell sleeve ends and black gold-lined cuffs, red knotted fastenings and gold edge embroidery, charcoal high-collar inner top, cinnabar pleated midi skirt with restrained gold embroidery at hem and narrow charcoal/gold accent panel, charcoal waistband, same single round ivory/red waist pendant, same short black gold-trim boots. No original long white outer robe or huge hanging sleeves.
Invariants: Same Siming chibi woman, warm brown eyes, small gentle face, fair skin, long dark hair with deep-red inner lengths, half-up hairstyle, same gold hairpin and red tassel earrings; approximately 2.7 heads tall. Keep Image 1 pose/face angle/expression/head-size/body-scale/hand locations/book orientation. Hands join sleeves cleanly and grip the book naturally; exactly two arms and hands, no holes, detached wrists, duplicate body parts, elongated neck, or overlap artifacts. The changed clothes must adapt naturally to the pose without changing its meaning.
Style: match Image 2's delicate warm anime linework, crisp edges and soft shading. Single complete character on portrait 2:3 canvas, roomy transparent margin, no crop. Genuine transparent alpha, NO glow or shadow outside character, no floor or background, no checkerboard, no text/labels/watermark, no extra props. Keep ivory clothes, pages, skin and eye whites opaque.
```

## picked-up

```text
Use case: identity-preserve.
Asset type: one complete transparent RGBA desktop pet character sprite, outfit 02, picked-up action.
Input images: Image 1 is the exact POSE, expression, proportions and composition to edit. Image 2 is the canonical SECOND OUTFIT and character drawing reference. Transfer the clothing of Image 2 onto Image 1, do not copy Image 2's standing posture.
Primary request: Retain Image 1's gently picked-up full-body pose exactly: tilted head, raised shoulders, round small surprised mouth, brown eyes open looking slightly up; two hands hug the closed brown book closely against the chest. Legs dangle, knees bend slightly, one boot hangs lower than the other. New short jacket and cuff sleeves fall naturally downward with gravity, skirt hangs down over upper legs; no flying long sleeves. No visible mouse cursor, lifting hand, string, hook, shadow or action lines.
Outfit contract: EXACT same second outfit as Image 2: ivory waist-length open short Chinese-style jacket with modest bell sleeve ends and black gold-lined cuffs, red knotted fastenings and gold edge embroidery, charcoal high-collar inner top, cinnabar pleated midi skirt with restrained gold embroidery at hem and narrow charcoal/gold accent panel, charcoal waistband, same single round ivory/red waist pendant, same short black gold-trim boots. No original long white outer robe or huge hanging sleeves.
Invariants: Same Siming chibi woman, warm brown eyes, small gentle face, fair skin, long dark hair with deep-red inner lengths, half-up hairstyle, same gold hairpin and red tassel earrings; approximately 2.7 heads tall. Keep Image 1 pose/face angle/expression/head-size/body-scale/hand locations/book orientation. Hands join sleeves cleanly and grip the book naturally; exactly two arms and hands, no holes, detached wrists, duplicate body parts, elongated neck, or overlap artifacts. The changed clothes must adapt naturally to the pose without changing its meaning.
Style: match Image 2's delicate warm anime linework, crisp edges and soft shading. Single complete character on portrait 2:3 canvas, roomy transparent margin, no crop. Genuine transparent alpha, NO glow or shadow outside character, no floor or background, no checkerboard, no text/labels/watermark, no extra props. Keep ivory clothes, pages, skin and eye whites opaque.
```

## standing-half

```text
Use case: precise-object-edit. Asset type: half-closed eye frame for an existing transparent desktop-pet sprite.
Input Image 1 is the EXACT image to edit, not an inspirational reference.
Change ONLY the two eyes to the HALF-CLOSED midpoint of a natural blink: upper eyelids lowered about halfway, narrow but clearly visible lower portions of the same brown irises, matching eyelash line style and perspective. Both eyes blink simultaneously. This is not a wink and not a sleepy redesign.
Lock every other pixel/feature as closely as possible: same 1024x1536 portrait canvas, same character position/size, same head angle, face outline, brow position, nose, mouth expression, hair, second outfit, hands, fingers, book, skirt, boots, lighting, silhouette and alpha. Do NOT move the eyes, enlarge them, tilt the head, alter pose or rescale/crop the image. For tilted faces the eyelids follow that exact angle.
Genuine transparent alpha remains, no outside shadow/glow, no solid backdrop or painted checkerboard. Output one whole sprite, no collage or extra views/text.
```

## reading-half

```text
Use case: precise-object-edit. Asset type: half-closed eye frame for an existing transparent desktop-pet sprite.
Input Image 1 is the EXACT image to edit, not an inspirational reference.
Change ONLY the two eyes to the HALF-CLOSED midpoint of a natural blink: upper eyelids lowered about halfway, narrow but clearly visible lower portions of the same brown irises, matching eyelash line style and perspective. Both eyes blink simultaneously. This is not a wink and not a sleepy redesign.
Lock every other pixel/feature as closely as possible: same 1024x1536 portrait canvas, same character position/size, same head angle, face outline, brow position, nose, mouth expression, hair, second outfit, hands, fingers, book, skirt, boots, lighting, silhouette and alpha. Do NOT move the eyes, enlarge them, tilt the head, alter pose or rescale/crop the image. For tilted faces the eyelids follow that exact angle.
Genuine transparent alpha remains, no outside shadow/glow, no solid backdrop or painted checkerboard. Output one whole sprite, no collage or extra views/text.
```

## peeking-half

```text
Use case: precise-object-edit. Asset type: half-closed eye frame for an existing transparent desktop-pet sprite.
Input Image 1 is the EXACT image to edit, not an inspirational reference.
Change ONLY the two eyes to the HALF-CLOSED midpoint of a natural blink: upper eyelids lowered about halfway, narrow but clearly visible lower portions of the same brown irises, matching eyelash line style and perspective. Both eyes blink simultaneously. This is not a wink and not a sleepy redesign.
Lock every other pixel/feature as closely as possible: same 1024x1536 portrait canvas, same character position/size, same head angle, face outline, brow position, nose, mouth expression, hair, second outfit, hands, fingers, book, skirt, boots, lighting, silhouette and alpha. Do NOT move the eyes, enlarge them, tilt the head, alter pose or rescale/crop the image. For tilted faces the eyelids follow that exact angle.
Genuine transparent alpha remains, no outside shadow/glow, no solid backdrop or painted checkerboard. Output one whole sprite, no collage or extra views/text.
```

## picked-up-half

```text
Use case: precise-object-edit. Asset type: half-closed eye frame for an existing transparent desktop-pet sprite.
Input Image 1 is the EXACT image to edit, not an inspirational reference.
Change ONLY the two eyes to the HALF-CLOSED midpoint of a natural blink: upper eyelids lowered about halfway, narrow but clearly visible lower portions of the same brown irises, matching eyelash line style and perspective. Both eyes blink simultaneously. This is not a wink and not a sleepy redesign.
Lock every other pixel/feature as closely as possible: same 1024x1536 portrait canvas, same character position/size, same head angle, face outline, brow position, nose, mouth expression, hair, second outfit, hands, fingers, book, skirt, boots, lighting, silhouette and alpha. Do NOT move the eyes, enlarge them, tilt the head, alter pose or rescale/crop the image. For tilted faces the eyelids follow that exact angle.
Genuine transparent alpha remains, no outside shadow/glow, no solid backdrop or painted checkerboard. Output one whole sprite, no collage or extra views/text.
```

## standing-closed

```text
Use case: precise-object-edit. Asset type: fully closed eye blink frame for a transparent desktop-pet sprite.
Input Image 1 is the exact image to edit.
Change ONLY the two eyes into completely CLOSED eyelids for a brief ordinary blink. There must be no visible pupils, irises or eye whites, just delicate curved lash lines and natural skin above them, matching each eye's perspective and face tilt. Both eyelids close simultaneously; not a wink, no tears or sleep symbols.
Keep all other artwork and registration unchanged: exact 1024x1536 portrait canvas, same framing and scale, same head and face silhouette/position, brows, nose, mouth expression, hair, outfit, book, hands, arms, skirt, boots and transparent silhouette. Do not rotate, crop, shift or resize the character. This must align with the original for local eye-only masking, NOT a newly drawn pose.
Preserve genuine transparent alpha; no glow/shadow outside the silhouette, no backdrop, checkerboard, text, collage, border or watermark. One complete sprite only.
```

## reading-closed

```text
Use case: precise-object-edit. Asset type: fully closed eye blink frame for a transparent desktop-pet sprite.
Input Image 1 is the exact image to edit.
Change ONLY the two eyes into completely CLOSED eyelids for a brief ordinary blink. There must be no visible pupils, irises or eye whites, just delicate curved lash lines and natural skin above them, matching each eye's perspective and face tilt. Both eyelids close simultaneously; not a wink, no tears or sleep symbols.
Keep all other artwork and registration unchanged: exact 1024x1536 portrait canvas, same framing and scale, same head and face silhouette/position, brows, nose, mouth expression, hair, outfit, book, hands, arms, skirt, boots and transparent silhouette. Do not rotate, crop, shift or resize the character. This must align with the original for local eye-only masking, NOT a newly drawn pose.
Preserve genuine transparent alpha; no glow/shadow outside the silhouette, no backdrop, checkerboard, text, collage, border or watermark. One complete sprite only.
```

## peeking-closed

```text
Use case: precise-object-edit. Asset type: fully closed eye blink frame for a transparent desktop-pet sprite.
Input Image 1 is the exact image to edit.
Change ONLY the two eyes into completely CLOSED eyelids for a brief ordinary blink. There must be no visible pupils, irises or eye whites, just delicate curved lash lines and natural skin above them, matching each eye's perspective and face tilt. Both eyelids close simultaneously; not a wink, no tears or sleep symbols.
Keep all other artwork and registration unchanged: exact 1024x1536 portrait canvas, same framing and scale, same head and face silhouette/position, brows, nose, mouth expression, hair, outfit, book, hands, arms, skirt, boots and transparent silhouette. Do not rotate, crop, shift or resize the character. This must align with the original for local eye-only masking, NOT a newly drawn pose.
Preserve genuine transparent alpha; no glow/shadow outside the silhouette, no backdrop, checkerboard, text, collage, border or watermark. One complete sprite only.
```

## picked-up-closed

```text
Use case: precise-object-edit. Asset type: fully closed eye blink frame for a transparent desktop-pet sprite.
Input Image 1 is the exact image to edit.
Change ONLY the two eyes into completely CLOSED eyelids for a brief ordinary blink. There must be no visible pupils, irises or eye whites, just delicate curved lash lines and natural skin above them, matching each eye's perspective and face tilt. Both eyelids close simultaneously; not a wink, no tears or sleep symbols.
Keep all other artwork and registration unchanged: exact 1024x1536 portrait canvas, same framing and scale, same head and face silhouette/position, brows, nose, mouth expression, hair, outfit, book, hands, arms, skirt, boots and transparent silhouette. Do not rotate, crop, shift or resize the character. This must align with the original for local eye-only masking, NOT a newly drawn pose.
Preserve genuine transparent alpha; no glow/shadow outside the silhouette, no backdrop, checkerboard, text, collage, border or watermark. One complete sprite only.
```
