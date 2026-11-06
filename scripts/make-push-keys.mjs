// Creates the key pair for phone notifications and adds it to .env (VAPID keys).
// Run through make-push-keys.bat. Never replaces keys that already exist: changing them
// would switch off every phone that has notifications turned on.
import { generateKeyPairSync } from "node:crypto"
import { appendFileSync, existsSync, readFileSync } from "node:fs"

if (!existsSync(".env")) {
  console.log("No .env file found. Run create-env.bat first.")
  process.exit(1)
}
const current = readFileSync(".env", "utf8")
if (/^VAPID_PUBLIC_KEY=\S+/m.test(current) && /^VAPID_PRIVATE_KEY=\S+/m.test(current)) {
  console.log("The notification keys are already in .env - nothing changed.")
  process.exit(0)
}
if (/^VAPID_(PUBLIC|PRIVATE)_KEY=/m.test(current)) {
  console.log("Found an unfinished VAPID line in .env. Delete the VAPID_ lines, then run this again.")
  process.exit(1)
}

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
const jwk = privateKey.export({ format: "jwk" })
const b64 = (text) => Buffer.from(text, "base64url")
const publicKey = Buffer.concat([Buffer.from([4]), b64(jwk.x), b64(jwk.y)]).toString("base64url")

const lines = [
  "",
  "# Phone notifications for new orders (made by make-push-keys.bat). Keep the private key secret.",
  `VAPID_PUBLIC_KEY=${publicKey}`,
  `VAPID_PRIVATE_KEY=${jwk.d}`,
  "",
]
appendFileSync(".env", (current.endsWith("\n") || current === "" ? "" : "\r\n") + lines.join("\r\n"))
console.log("Added the notification keys to .env (the private key is not shown).")
