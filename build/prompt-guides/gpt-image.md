# Prompt guide: GPT Image (OpenAI image models)

Guidance drawn from OpenAI's image generation prompting guide (developers.openai.com cookbook). Covers gpt_image_2, gpt_image_2_5 and similar. Edit freely.

- Keep a fixed order: background or scene, then subject, then details, then constraints. Use labelled lines for long requests ("Composition:", "Style:", "Constraints:").
- Logos and icons: describe the brand's personality and where the mark is used; ask for clean, vector-like shapes, a strong silhouette and balanced negative space; keep it simple so it reads small.
- Transparent background (gpt_image_2_5 has a background parameter): ask for "an isolated subject on a fully transparent background", with no scenery, backdrop, checkerboard or cast shadow.
- Text: put the literal text in quotes or ALL CAPS, give font style, size, colour and placement, and ask for it verbatim with no extra characters. Spell unusual words letter by letter. Use medium or high quality for small text.
- Editing with references: refer to each input by number and what it is ("image 1, the current icon"). Separate what changes from what must stay the same, and repeat the "keep" list on every iteration.
