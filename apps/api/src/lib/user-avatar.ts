export function userAvatarUrl(user: { id: string; avatarSha256?: string | null }) {
  return user.avatarSha256 ? `/api/v1/users/${user.id}/avatar?v=${user.avatarSha256.slice(0, 12)}` : null;
}
