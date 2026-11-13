# Security policy

## Supported versions

The latest released minor version receives security fixes.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting on this
repository (the **Security** tab, then **Report a vulnerability**). You will get an answer
within a few days.

## Things to keep in mind when you deploy

- The check prompt contains clipped copies of the agent's replies and of delivered
  messages. Treat the store and delivered-log files as you treat conversation logs: keep
  them out of public folders and backups you share.
- The check turn resumes a live agent session. If that agent has tools, it has them
  during the check too. Limit tools and turn length in `runTurn` as you see fit.
- Text returned by the check turn is sent to the user as is. Apply the same output
  filtering you apply to normal replies inside `deliver`.
