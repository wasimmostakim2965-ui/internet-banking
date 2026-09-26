/**
 * The monorepo root directory: one validator for both write paths.
 *
 * A project may build from a subdirectory of its repository — Vercel's "Root
 * Directory". The value is forwarded to the engine as Coolify's `base_directory`,
 * which applies it to every install, build and start command, so a path that
 * escapes the checkout would run the build outside the source tree. It is
 * validated at the API boundary, once, so the projects page and the deploy
 * procedure cannot disagree about what is acceptable.
 *
 * An empty or absent value is null — the repository root, the same meaning the
 * column's null carries. A non-empty value must be a plain relative path: no
 * leading `/`, no backslash, no `.`/`..` segment and no empty segment. Those are
 * refused rather than silently normalised, because a caller who typed `../app`
 * meant something the platform will not do.
 */
import { ApiError } from "./errors.js";

const SEGMENT = /^[A-Za-z0-9._-]+$/;
const MAX_LENGTH = 200;

export function parseRootDirectory(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return null;

  const normalised = trimmed.replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (normalised === "") return null;
  if (normalised.startsWith("/") || normalised.includes("\\")) {
    throw new ApiError(
      "invalid_input",
      "Root directory must be a relative path inside the repository.",
    );
  }
  const segments = normalised.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new ApiError(
      "invalid_input",
      "Root directory cannot contain '..', '.' or an empty path segment.",
    );
  }
  if (!segments.every((segment) => SEGMENT.test(segment))) {
    throw new ApiError(
      "invalid_input",
      "Root directory may contain letters, digits, '.', '_', '-' and '/' only.",
    );
  }
  if (normalised.length > MAX_LENGTH) {
    throw new ApiError(
      "invalid_input",
      `Root directory must be ${MAX_LENGTH} characters or fewer.`,
    );
  }
  return normalised;
}
