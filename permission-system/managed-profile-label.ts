/** Display only: keep internal profile IDs in every permission/identity fact. */
export function publicProfileLabel(profile: string): string {
  return profile === "editor" ? "worker" : profile;
}
