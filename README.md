# Campus-Link

### A campus-focused peer-to-peer delivery platform for VIT Vellore

Campus-Link is a peer-to-peer delivery platform designed for university campuses. It allows students to request deliveries and enables other students to accept and complete those requests.

The system is designed around the constraints of a university environment, including campus locations, hostel blocks, student verification, delivery workflows, real-time communication, email verification, reputation, and access control.

## Live Demo

**Website:** https://campslink.shop/

## Features

### Peer-to-Peer Delivery

* Create and manage delivery requests
* Accept and complete delivery requests
* Order lifecycle management
* Delivery distance and location handling
* Order cancellation and stale-order handling
* Delivery status tracking

### Campus Location System

* Campus-specific locations and buildings
* Hostel and academic block support
* Nearby location discovery
* Location and route management
* Campus-specific delivery points

### Authentication and Security

* VIT student email verification
* VIT email-domain enforcement
* Password recovery
* Authentication and authorization
* Row Level Security through Supabase
* Database-level access control
* Rate limiting for sensitive operations
* Protected order and delivery operations
* Trust and safety mechanisms

### Email and Notifications

* Transactional email delivery using Resend
* Account verification emails
* Password recovery emails
* In-app notifications
* Order-related notifications
* Notification access control

### Ratings and Reputation

* Post-delivery ratings
* User reputation system
* Reputation-based trust signals
* Validation of rating operations

### Communication

* Order-specific chat
* Real-time communication
* Notifications for order events
* Friend requests and social interactions

### Social Features

* Friend requests
* User relationships
* Social notifications
* Profile reputation

### Analytics

* Order and application analytics
* User activity data
* Backend analytics functionality
* PostgreSQL-based analytics infrastructure

### User Preferences

* Persistent user preferences
* Preference-based application behavior
* Personalized functionality

## Tech Stack

### Frontend

* React
* TypeScript
* Vite
* Tailwind CSS
* shadcn/ui

### Backend

* Supabase
* PostgreSQL
* Supabase Auth
* PostgreSQL Functions
* Row Level Security
* Supabase Realtime

### Email and Infrastructure

* Resend
* Vercel
* GitHub

### Development

* Vitest
* ESLint

## Architecture

```text
                    React Application
             TypeScript + Vite + Tailwind
                           |
                           |
                    Supabase Client
                           |
             +-------------+-------------+
             |             |             |
        Authentication   Database     Realtime
             |             |             |
             +-------------+-------------+
                           |
                       PostgreSQL
                           |
        +------------------+------------------+
        |          |         |        |       |
      Orders    Users    Locations  Social  Analytics
        |          |         |        |       |
        +----------+---------+--------+-------+
                           |
                    Row Level Security
                           |
                  Server-side Services
                           |
                         Resend
                           |
             Verification & Recovery Emails
```

## Delivery Workflow

```text
Create Order
     |
     v
Order Available
     |
     v
Student Accepts
     |
     v
Delivery In Progress
     |
     v
Order Delivered
     |
     v
Rating and Reputation Update
```

The system also handles cancellation, stale orders, delivery restrictions, notifications, and authorization checks throughout the order lifecycle.

## Database

Campus-Link uses PostgreSQL through Supabase as its primary data layer.

The database is managed through versioned migrations covering areas including:

* Users and profiles
* Orders
* Locations
* Delivery routes
* Notifications
* Ratings
* Friendships
* User preferences
* Analytics
* Reports
* Rate limiting
* Campus blocks
* Authentication and email verification
* Order chat

Database access is controlled using Row Level Security policies and PostgreSQL functions, allowing authorization rules to be enforced at the database level rather than relying solely on frontend checks.

## Security

Security is implemented at both the application and database levels.

Key mechanisms include:

* VIT email-domain verification
* Authentication and authorization
* Row Level Security
* Database-level access policies
* Rate limiting
* Protected order operations
* Delivery acceptance restrictions
* Reporting and trust mechanisms
* Controlled access to notifications and social data
* Server-side handling of email service credentials

Environment-specific configuration is handled through environment variables rather than committed credentials.

## Getting Started

### Prerequisites

* Node.js
* npm
* A Supabase project

### Installation

Clone the repository:

```bash
git clone https://github.com/BUCKS10101/Campus-Link.git
cd Campus-Link
```

Install dependencies:

```bash
npm install
```

Create the environment file:

```bash
cp .env.example .env
```

Add the required application and Supabase configuration to `.env`.

Start the development server:

```bash
npm run dev
```

## Testing

The project uses Vitest for testing.

```bash
npm run test
```

## Project Structure

```text
Campus-Link/
├── public/
├── scripts/
├── src/
├── supabase/
│   └── migrations/
├── .env.example
├── .gitignore
├── package.json
├── vite.config.ts
├── vitest.config.ts
└── README.md
```

## Development

Campus-Link has evolved through multiple development phases covering:

1. Core delivery functionality
2. Campus location infrastructure
3. Nearby discovery
4. Notifications
5. Ratings and reputation
6. Social graph
7. Personalization
8. Analytics
9. Trust and safety
10. Authentication and verification
11. Rate limiting and abuse prevention
12. Transactional email infrastructure

The repository contains the corresponding implementation and database migrations.

## Deployment

Campus-Link is deployed as a live web application using Vercel and is accessible through a custom domain:

**https://campslink.shop/**

The production application uses Supabase for backend services and Resend for transactional email delivery, including account verification and password recovery.

Users do not need a separate Resend account to use Campus-Link.

## Project Status

Campus-Link is actively under development.

The current implementation focuses on building a complete campus delivery platform with location-aware delivery workflows, authentication, social features, email communication, security controls, and analytics.

The latest production build is available at:

**https://campslink.shop/**

## Author

**Govind Nair**

B.Tech Computer Science and Engineering — Cyber Security
VIT Vellore

GitHub: https://github.com/BUCKS10101

