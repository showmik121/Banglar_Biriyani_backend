import { describe, test, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "../..")

describe("repository safety", () => {
  test(".gitignore keeps .env files out of git", () => {
    const lines = fs
      .readFileSync(path.join(root, ".gitignore"), "utf-8")
      .split(/\r?\n/)
      .map((l) => l.trim())
    expect(lines).toContain(".env")
    expect(lines).toContain(".env.*")
    expect(lines).toContain("!.env.example")
  })

  test(".env.example documents every required variable without real secrets", () => {
    const example = fs.readFileSync(path.join(root, ".env.example"), "utf-8")
    for (const key of ["DATABASE_URL", "JWT_SECRET", "API_PORT"]) {
      expect(example).toMatch(new RegExp(`^${key}=`, "m"))
    }
    expect(example).toContain("[YOUR-PASSWORD]")
    expect(example).not.toMatch(/postgres(ql)?:\/\/[^\s]*:(?!\[YOUR-PASSWORD\])[^@\s]+@/)
  })
})
