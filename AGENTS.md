# General Guidelines

Keep solutions simple. Start with the minimal implementation that solves the problem. Don't add extra suggestions or features unless explicitly requested.

## Code Organization

Before creating new utility modules or helper files, check for existing utils in the project and reuse them. Run `find . -name '*util*' -o -name '*helper*'` first.

## Environment Setup

Python environment: Use the virtual environment at the project root. If unsure, ask user for the correct Python path before attempting multiple failed runs.

## Performance & Data Access

When implementing features, prefer using existing cached data files over making API calls. Check for local data sources first before fetching from external APIs.
