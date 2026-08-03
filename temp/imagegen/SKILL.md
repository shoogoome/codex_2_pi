---
name: imagegen
description: Generate raster images when the user asks for AI-created bitmap visuals such as photos, illustrations, sprites, mockups, product shots, or transparent/background-ready assets. Do not use for SVG/vector/code-native assets that should be edited directly.
---

# Pi Image Generation Skill

Use the `generate_image` tool for raster image generation requests. The tool reads image-model configuration from `~/.pi/agent/models.json` providers where `type` is `"image"`, currently supporting `api: "openai-images"`.

## Rules

- Use `generate_image` for new bitmap images, illustrations, mockups, sprites, product shots, and other generated raster assets.
- Do not use `generate_image` for deterministic SVG/vector/code-native assets when editing project files directly is better.
- `generate_image` returns only text and saved file paths. It intentionally does not return image bytes, so it will not add image data to model context.
- Tell the user they can run `/images` to preview generated or referenced local image paths in the TUI.
- If the asset is meant for the current project, copy or move the generated file into the workspace and report the final project path.
- Do not overwrite existing project assets unless the user explicitly asks for replacement.

## Configuration example

```json
{
  "providers": {
    "openai-image": {
      "type": "image",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "OPENAI_API_KEY",
      "api": "openai-responses",
      "models": [],
      "imageModels": [
        {
          "id": "gpt-image-1",
          "name": "GPT Image 1",
          "api": "openai-images",
          "defaultSize": "1024x1024",
          "defaultFormat": "png"
        }
      ]
    }
  }
}
```

## Workflow

1. Clarify the image prompt when needed: subject, style, composition, text, constraints, output use.
2. Call `generate_image` with a clear production-oriented prompt.
3. Report the saved path and the model used.
4. For preview-only work, ask the user to run `/images` if they want to view it.
5. For project-bound assets, move/copy the selected image into the repository and update references if requested.
