# Zakir Parkar - Architecture Portfolio Website

A responsive architecture portfolio with:

- premium editorial-style design
- project filtering and case-study modal views
- visuals extracted from the supplied portfolio PDFs
- project details for residential, commercial, public and technical work
- appointment date/time selection
- double-booking protection
- local JSON appointment storage
- email notifications to Ayman and Zakir
- client confirmation email
- optional WhatsApp appointment alerts to Zakir
- phone, WhatsApp and email contact CTAs
- no frontend framework and no npm packages required

## Run locally

1. Install Node.js 18+.
2. Copy `.env.example` to `.env`.
3. Add a Gmail App Password for the sending Gmail account.
4. Run:

```bash
npm start
```

5. Open `http://localhost:3000`.

The site still works without SMTP configured: appointment requests are stored in `data/appointments.json`, but email notifications will be disabled.

## Gmail setup

For Gmail SMTP, turn on 2-Step Verification for the sending Gmail account and create a Google App Password. Put that 16-character App Password in `SMTP_PASS`. Google says App Passwords require 2-Step Verification and are a 16-digit passcode.

The default notification recipients are:

- aymanzakir28@gmail.com
- zparkar1@gmail.com

Change `NOTIFY_EMAILS` in `.env` if needed.

## Deployment

This is a standard Node HTTP server, so it can be deployed on a Node-capable host such as Render, Railway, Fly.io or a VPS. Set the same environment variables in the host dashboard.

Because appointments are stored in `data/appointments.json`, use a persistent disk/volume on hosts where the filesystem is ephemeral. Email notifications remain the primary real-time alert mechanism.

## Customizing working hours

Edit `DEFAULT_SLOTS` in `server.js` to change the appointment times. The UI automatically follows the server's available slots.

## WhatsApp setup

The site can also send the new appointment details to Zakir on WhatsApp automatically. This is optional and uses Twilio's WhatsApp integration. For local testing, Twilio provides a WhatsApp Sandbox. For production, use an approved WhatsApp sender and the appropriate approved message template for business-initiated notifications.

Set these values in `.env`:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `WHATSAPP_FROM`
- `WHATSAPP_TO=whatsapp:+96892118458`
- `WHATSAPP_CONTENT_SID` (production template; leave blank only for compatible testing/session use)

The recommended template can have one variable, `{{1}}`, containing the full appointment details.
