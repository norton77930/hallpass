export function canonicalOriginFromUrl(urlText: string): string | undefined {
  try {
    const url = new URL(urlText);
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

export function originAssessmentBody(origin: string): { canonicalOrigin: string } {
  return { canonicalOrigin: origin };
}
