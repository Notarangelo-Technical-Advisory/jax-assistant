# Skill: Monthly Invoicing

Generate the monthly invoice for IHRDC.

## Trigger

First week of each month, or when Jack asks to generate an invoice.

## Instructions

1. **Data source:** The fta-time-tracker app (repo: `fta-time-tracker`) tracks time and generates invoices. Until MCP/API integration is built, Jack will need to run the app or provide the data.

2. Remind Jack to:
   - Review the previous month's time entries in fta-time-tracker
   - Verify all billable hours are logged
   - Generate the invoice via fta-time-tracker

3. Invoice details:
   - **Client:** IHRDC
   - **Rate:** $150/hr
   - **Period:** Previous calendar month's unbilled time
   - **Contact:** Brad Donohue

4. After invoice is generated, remind Jack to send it to Brad.

5. Log the invoice in `decisions/log.md`:
   ```
   [YYYY-MM-DD] DECISION: Sent [Month] invoice to IHRDC | REASONING: Monthly billing cycle | CONTEXT: $X,XXX for XX hours
   ```

## Status

**Manual with reminders.** Full automation depends on fta-time-tracker MCP/API integration.
