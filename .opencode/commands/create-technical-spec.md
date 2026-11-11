---
description: Create technical spec
model: opencode/big-pickle
---

Based on the draft of the technical-spec, created in a previous session,  
- The path to the draft of technical-spec file: `../docs/draft-technical-spec.md`

create a technical-spec that is ready for realization. Check if a technical-spec file exists or not. If not, create one. 

- The path to the technical-spec file: `../docs/technical-spec.md`

# System overview
The system overview is the starting point of your tech spec. it gives a simple technical description of the software without going too deep into implementation.

# Checklist system overview
System overview field | What to write
--- | ---
System name | The working name of the application or feature
Purpose | The main technical purpose of the system in one or two sentences
Primary users | The roles that interact with the system
Core capabilities | The main actions the system must support
System boundary | What this system will handle and what it will not handle
External dependencies | Servies, APIs, file systems, 
Assumptions | Conditions you are accepting for this version

# Format 
System name:
[Name]
Purpose:
[One or two sentences describing what the system does technically]
Primary users:
- [Role 1]
- [Role 2]
Core capabilities
- [Capability 1]
- [Capability 2]
Sysstem boundary:
This system includes [included areas].
This system does not include [excluded areas].
External dependencies:
- [Dependency 1]
- [Dependency 2]
Assumptions:
- [Assumption 1]
- [Assumption 2]


# Architecture Overview
The architecture overview explains how the system is divided into major parts. You only need to show the man pieces, their responsibilities, and how data oves between them. The important thing is not to sound complex. The important thing is to make responsibility clear.

# Checklist Architecture overview
Architecture | Decision to document
--- | ---
Architecture style | For example: simple web app, modular monlith, client-server app, or service-based design
Main components | Frontend, backend, database, worker, external service, or AI model layer.
Responsibility of each component | What each part owns and what it must not own
Data flow | How data moves from user action to response
State ownership | Where important state is stored and updated
Trade-offs | Why this design is acceptable for the current version

# Checklist Frontend requirements 
Frontend requirment area | What you should specify
--- | ---
Screens or pages | Dashboard, login page, settings page, list view, detail view, or form page
Components | Navigation, table, card, modal, form, search bar, filter, or status badge
Form fields | Required fields, optional fields, input type, placeholder, and validation rule
UI states | Loading, empty, error, success, disabled, and permission-denied states
User actions | Create, edit, delete, save, cancel, search, filter, export, or retry
Accessibility basics | Readable labels, keyboard-friendly navigation, and clear error messages

# Example Frontend requirement
Screen: Create Task
Purpose: Allow a signed-in team member to create a new task.
Fields:
- Title: required, text, maximum 120 charachters
- Description: optional, text area
- Due date: optional, date input
- Assignee: required, selected from workspace members
States:
- Loading: show saving indicator
- Success: return to task list and show the new task
- Error: explain what failed and keep the user input on screen

# Backend requirements
Backend requirements describe the server-side behavior that supports the product. This includes business logic, permission checks, data validation, service operations, background work, and integrations with other systems. 

Write backend rules in plain language first. Later, each rule can become a task, a test, and then code. This is how spec-driven work stys connected.

# Database requirments

Database requirements describe the information the system must store, how that information is related, and what rules protect it from becoming inconsistent.

# Checklist database requirements
Database requirement area | What to define
--- | ---
Entities | The main things stored by the system
Fields | The information each entity contains
Relationships | How entities connect to each other
Constraints | Required fields, unique fields, valid values, and limits
Indexes | Fields that should be searchable or frequently filtered
Retention and deletion | What happens when data is deleted or archived

# Example data requirement example
Entity: Task
Purpose: Stores a unit of work inside a project.
Fields:
- id: unique task identifier
- protect_id: required, links task to project
- title: required, max 120 charcters
- description: optinal
- status: pending, in_progress, completed
- assignee_id: optional, links task to user
- due_date: optional
- created_at: required timestamp
Relationship:
One project can have many tasks. 
One user can be assigned many tasks.

# API requirments
API requirements deine how the frontend, backend, and other parts of the system communicate. A clear API specification prevents inconsistent routes, unclear request bodies, mixed response formats, and weak error handling.

For each endpoint, define the method, path, purpose, authentication rule, request body, success response, error responses, and validation rules. 

# Example API requirements
Endpoint | Example
--- | ---
Method and path | POST /api/tasks
Purpose | Create a task inside a project
Authentication | Signed-in workspace member required
Request body | project_id, title, description, due_date, assignee_id
Success response | 201 Created with the created task object
Error responses | 400 for invalid input, 401 for missing login, 403 for no access, 404 for project not found
Validation | Title is required and cannot exceed 120 characters

# API contract example
POST /api/tasks
Purpose: Create a new task.
Auth: Required
Request:
{
    "project_id": "string",
    "title": "string",
    "description": "string",
    "due_date": "YYYY-MM-DD",
    "assignee_id": "string"
},
Success response: 201 Created
Error responses: 400, 401, 403, 404

# External Service Integration (optional)
An integration connects your system to something outside it. Examples include payment services, email providers, calender systems, identity providers, storage services, analytics tools, and AI model APIs. Your specification should explain what you send, what you receive, what you store, and what happens when the external service fails.

# External Service Integration Spec Items (optional)
Integration spec item | What you define
--- | ---
Provider | The external service being used.
Purpose | Why the system needs the service
Data sent | The exact fields sent out of your system
Data received | The exact fields returned to your system
Failure behavior | Retry, show message, log error, or queue for later
Security rule | How secrets, tokens, and sensitive data are protected

Security reminder: Never design an integration that exposes secrets to the frontend or stores tokens in plain text.

# Security requirments
Security requirements describe how the system protects users, data, permissions, secrets, and important actions. Security should not be added as an aftherthought. You should define security expectations befor implementation.

# Security requirment example
Security area | Requirement example
--- | ---
Authentication | users must sign in before accessing private project data.
Authorization | Users can only view tasks in workspaces they belong to
Input validation | All user input must be validated on the backend before storage
Sensitive data | Passwords must never be stored as plain text
Secrets | API keys and tokens must not appear in sources files or examples
Safe errors | Error messages must not reveal stack traces or private data to users

# Performance requirements
Performance requirements define how fast or efficient the system should be under expected conditions. 

Set realistic targets for the version you are building now. Overengineering performane too early can make the system harder to finish and harder to understand.

# Error handling requirements
Error handling requirements explain what should happen when something goes wrong. This includes invalid input, missing permission, network failure, database failure, unavailable services, duplicate actions, and unexpected server errors.

# Error handling example
Error situation | Expected behavior
--- | ---
Missing required field | Reject the request, explain the missing field, and keep the user input on screen.
Not signed in | Return 401 and ask the user to sign in
No permission | Return 403 and explain that the user cannot access the resource
Resource not found | Return 404 with a safe message
External service failure | Retry if safe, otherwise show a temporary failure message
Unexpected server error | Return a general error message and log the details internally

# Technical Specification Template
1. System Overview: name; purpose; users; capabilities; boundaries; dependencies; aussumptions
2. Architecture Overview: style; components; responsibilities; data flow; trade-offs
3. Frontend Requirments: screens; components; forms; validation; UI states; accessibility basics
4. Backend Requirments: services; business rules; authorization rules; validation; jobs; integrations
5. Database Requirments: entities; fields; relationships; constraints; indexes; retention/deletion rules
6. API Requirments endpoint; method; path; purpose; auth rule; request; success response; errors
7. Security Requirements: authentication; authorization; input validation; sensitive data; secrets; safe errors
8. Performance Requirments: expected users/data size; response targets; search targets; known limits
9. Error Handling Requirements: user messages; internal logging; retry rules; fallback behavior
10. Open Questions: question; decision owner; whether it must be answered before implementation
