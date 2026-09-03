/**
 * Runs in every test file before the file's own imports are evaluated, which is
 * what makes it safe for application modules to read `process.env` at import
 * time.
 */
import './test-env';
