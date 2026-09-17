# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v56.0.0/ before writing any code.

## Project Status (Updated)

### Completed

- Voice-first Home screen redesign is implemented:
	- Two primary buttons: "Add Tasks" (capture) and "What's Done?" (review)
	- Profile and Settings quick actions
	- Progress bar and pending check-in nudge
- Task Group icon grid is implemented:
	- Group bubbles by subgroup/category
	- Emoji + completion badge + counts
	- Tap opens bottom-sheet style popup with grouped tasks
- Task detail chips are implemented in task rows:
	- Location, deadline, contact, how, why
- Task schema and extraction pipeline are extended:
	- Added fields: how, why, contactName, contactPhone
	- Agent prompt updated to request these fields
	- Parsing/storage wiring updated end-to-end
- Check-in review confirmation improved:
	- Lumi now reports completed count and still-pending count
- TypeScript validation passed with no errors (`npx tsc --noEmit`)
- Onboarding local fallback extraction is in place for API failures
- Android debug build/install verified on physical device:
	- Device: SM-S921E (Android 16)
	- Install task: `:app:installDebug`
	- Result: Installed on 1 device, BUILD SUCCESSFUL

### Not Completed Yet

- Nebius API key issue (401 Unauthorized) is still unresolved:
	- Voice STT works
	- Remote AI extraction requires valid key rotation/update in `.env`
- Full on-device UX verification checklist still pending after latest UI changes:
	- Add Tasks flow end-to-end
	- What's Done flow end-to-end
	- Group popup interactions (toggle/delete/edit)
	- Task detail chip rendering for real voice-extracted data
