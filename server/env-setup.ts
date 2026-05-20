// Loads .env.schema plus local non-secret env files through Varlock.
// Imported for side effects — must run before any module reads process.env.
import "varlock/auto-load";
