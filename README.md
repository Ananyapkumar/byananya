# byananya.com

## Before going live, replace these
- assets/photo.jpg: add your photo (square, about 400x400px, under 150 KB)
- Optional: fill the "ADD NUMBER" comments and the project template for Redline

## Adding a blog post
1. Copy posts/_template.md and rename it, e.g. posts/my-first-n8n-workflow.md
2. Add an entry to posts/index.json:
   { "slug": "my-first-n8n-workflow", "title": "...", "date": "2026-11-05", "summary": "...", "topic": "tech" }
   topic: "tech" shows under Writing (weekly AI/automation posts)
          "health" shows under Monthly health log
   (slug = file name without .md; keep the commas between entries)
3. Commit and push. It shows up on the homepage automatically.

## Preview on your laptop
The writing list needs a local server (it won't load by double-clicking index.html):
    python -m http.server 8000
then open http://localhost:8000
