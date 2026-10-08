import { defineConfig } from 'vitest/config'

// Unit tests only; Firestore rules tests (firebase/tests) need the emulator: cd firebase/tests && npm test
export default defineConfig({ test: { include: ['tests/**/*.test.ts'] } })
