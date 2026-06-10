from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from datetime import datetime
from pathlib import Path
import json
import uuid
import re

app = FastAPI(title="Udonarium Lycoris Bulletin Board")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DATA_DIR = Path("/var/www/bulletin-board-data")
DATA_DIR.mkdir(parents=True, exist_ok=True)

# --- Models ---
class PostCreate(BaseModel):
    name: str = Field(default="名無しさん", max_length=50)
    title: str = Field(..., min_length=1, max_length=200)
    body: str = Field(..., min_length=1, max_length=5000)
    category: str = Field(default="request")  # "request" or "bug"

class Post(PostCreate):
    id: str
    created_at: str
    replies: list = []

class ReplyCreate(BaseModel):
    name: str = Field(default="名無しさん", max_length=50)
    body: str = Field(..., min_length=1, max_length=2000)

class Reply(ReplyCreate):
    id: str
    created_at: str

# --- Helpers ---
def sanitize(text: str) -> str:
    """Basic XSS prevention"""
    text = re.sub(r'<[^>]+>', '', text)
    return text.strip()

def load_posts(category: str) -> list:
    file = DATA_DIR / f"{category}.json"
    if not file.exists():
        return []
    with open(file, 'r', encoding='utf-8') as f:
        return json.load(f)

def save_posts(category: str, posts: list):
    file = DATA_DIR / f"{category}.json"
    with open(file, 'w', encoding='utf-8') as f:
        json.dump(posts, f, ensure_ascii=False, indent=2)

# --- Routes ---
@app.get("/api/posts/{category}")
def get_posts(category: str):
    if category not in ("request", "bug"):
        raise HTTPException(400, "Invalid category")
    posts = load_posts(category)
    # 最新順
    posts.sort(key=lambda p: p["created_at"], reverse=True)
    return posts

@app.post("/api/posts/{category}", status_code=201)
def create_post(category: str, post: PostCreate):
    if category not in ("request", "bug"):
        raise HTTPException(400, "Invalid category")
    posts = load_posts(category)
    new_post = {
        "id": uuid.uuid4().hex[:12],
        "name": sanitize(post.name),
        "title": sanitize(post.title),
        "body": sanitize(post.body),
        "category": category,
        "created_at": datetime.utcnow().isoformat() + "Z",
        "replies": []
    }
    posts.append(new_post)
    save_posts(category, posts)
    return new_post

@app.post("/api/posts/{category}/{post_id}/replies", status_code=201)
def create_reply(category: str, post_id: str, reply: ReplyCreate):
    if category not in ("request", "bug"):
        raise HTTPException(400, "Invalid category")
    posts = load_posts(category)
    post = next((p for p in posts if p["id"] == post_id), None)
    if not post:
        raise HTTPException(404, "Post not found")
    new_reply = {
        "id": uuid.uuid4().hex[:12],
        "name": sanitize(reply.name),
        "body": sanitize(reply.body),
        "created_at": datetime.utcnow().isoformat() + "Z"
    }
    post["replies"].append(new_reply)
    save_posts(category, posts)
    return new_reply

@app.get("/api/posts/{category}/count")
def get_post_count(category: str):
    if category not in ("request", "bug"):
        raise HTTPException(400, "Invalid category")
    posts = load_posts(category)
    return {"count": len(posts)}

@app.get("/api/health")
def health():
    return {"status": "ok"}
