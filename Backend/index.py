"""Vercel Python Function entrypoint for the existing FastAPI application."""

from app.main import app


__all__ = ["app"]
