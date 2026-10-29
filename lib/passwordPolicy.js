// Partner-Passwort-Policy (strenger als die Käufer-Registrierung, die nur
// min. 6 Zeichen verlangt, siehe routes/auth.js) - auf Wunsch von Jens/Frank
// (2026-10-21): mind. 10 Zeichen, Groß-/Kleinbuchstabe, Sonderzeichen.
const PARTNER_PASSWORD_PATTERN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*[^A-Za-z0-9]).{10,}$/;
const PARTNER_PASSWORD_HINWEIS = 'Das Passwort muss mindestens 10 Zeichen lang sein und Groß-, Kleinbuchstaben sowie ein Sonderzeichen enthalten.';

module.exports = { PARTNER_PASSWORD_PATTERN, PARTNER_PASSWORD_HINWEIS };
