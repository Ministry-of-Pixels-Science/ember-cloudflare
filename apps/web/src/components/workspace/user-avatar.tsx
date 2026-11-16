import { useContext, useState } from "react";
import { avatarSvg, type DirectoryUser, type User } from "@ember/protocol";
import { PageLink } from "@/components/page-link";
import { PeopleContext, type People } from "@/hooks/use-directory";
import { personPath } from "@/hooks/use-route";
import { cn } from "@/lib/utils";
import { isAgent } from "./agent-badge";

/** How many drawings are kept: more people than a page shows at once, so a tab left open doesn't keep everyone it has shown. */
export const DRAWINGS_KEPT = 1_000;

/**
 * Avatars drawn in the page, by id and name, since a timeline shows the same people again and again.
 * Least recently used first, as a Map keeps insertion order.
 */
const drawings = new Map<string, string>();

/** Someone's initials avatar as the Worker draws it, as an image's address. The SVG is all ASCII, as `btoa` needs. */
function drawn({ id, name }: User): string {
  const key = `${id}\n${name}`;
  const url = drawings.get(key) ?? `data:image/svg+xml;base64,${btoa(avatarSvg(id, name))}`;
  drawings.delete(key);
  drawings.set(key, url);
  if (drawings.size > DRAWINGS_KEPT) drawings.delete(drawings.keys().next().value!);
  return url;
}

/** The address of someone's avatar: the image the people directory gives, or their initials until it lists them. */
export const avatarUrlOf = (people: People, user: User) => people.get(user.id)?.avatarUrl ?? drawn(user);

/** When someone last changed, as an address of their avatar says (`?v=`), so a later address has a larger one; 0 for initials drawn in the page. */
export const avatarVersionOf = (avatarUrl: string) => Number(new URL(avatarUrl, location.origin).searchParams.get("v"));

/**
 * Whether someone is a bot, as the people directory lists them, AI agents among them, or @ember, before
 * the directory lists anyone. A bot's avatar is a circle wherever it shows, so bots stand apart from the
 * people around them.
 */
const isBot = (user: User, listed: DirectoryUser | undefined) => listed?.role === "bot" || isAgent(listed ?? user);

interface Props {
  /** Someone, with their avatar's address where it's known, as the directory lists it. */
  user: User & Partial<Pick<DirectoryUser, "avatarUrl">>;
  className?: string;
  /** Whether a person's avatar is a square with rounded corners, as messages show people. A bot's is a circle all the same. */
  square?: boolean;
  /** Whether the image waits until it's scrolled near, as the people lists' do. */
  lazy?: boolean;
  /** What screen readers call the image, where it says something, as a boost's does. */
  label?: string;
}

/**
 * Someone's avatar, the image the people directory gives the address of, or `user` does until the
 * directory lists them, as a bot just added, hidden from screen readers unless it has a label. Until it
 * loads, or if it can't, or neither gives one, their initials show as the Worker would draw them. Once a
 * picture has loaded, nothing's drawn behind it, so one that's see-through, as a logo often is, shows
 * what's around it there. A photo that isn't square covers it, as Campfire's `.avatar img` does. Messages
 * show people as squares with 6px corners, and the rail and presence as circles; a bot, @ember among
 * them, is a circle everywhere.
 */
export function UserAvatar({ user, className, square = false, lazy = false, label }: Props) {
  const listed = useContext(PeopleContext).get(user.id);
  const served = listed?.avatarUrl ?? user.avatarUrl;
  const [failed, setFailed] = useState<string | null>(null);
  // Whether a picture has loaded: a browser goes on showing it while the next address it's given loads.
  const [loaded, setLoaded] = useState(false);
  // The initials of the name they have now, which may be newer than the one copied into `user`.
  const placeholder = drawn(listed ?? user);
  return (
    <img
      src={served && served !== failed ? served : placeholder}
      alt={label ?? ""}
      aria-hidden={label === undefined || undefined}
      loading={lazy ? "lazy" : undefined}
      onLoad={() => setLoaded(true)}
      onError={() => served && setFailed(served)}
      className={cn(
        "inline-block size-9 shrink-0 select-none bg-cover object-cover",
        square ? "rounded-[6px]" : "rounded-full",
        className,
        // Last, so a bot's stays a circle whatever corners the place gives people's.
        isBot(user, listed) && "rounded-full",
      )}
      style={loaded ? undefined : { backgroundImage: `url("${placeholder}")` }}
    />
  );
}

/** Someone's name, then their bio after a dash where they've written one. */
export const userTitle = ({ name, bio }: { name: string; bio?: string | null }) => (bio?.trim() ? `${name} – ${bio}` : name);

/**
 * How far around an avatar link takes taps on touch screens, centered on it. It's drawn with insets,
 * not a transform, so the phone audits can measure it.
 */
const TOUCH_REACH = {
  /** 44px across, as Ember sizes controls for fingers. */
  finger: "touch:after:absolute touch:after:inset-[calc(50%-22px)]",
  /** 24px, WCAG 2.5.8's floor, where it sits among small targets, as in a reaction. */
  dense: "touch:after:absolute touch:after:inset-[calc(50%-12px)]",
  /** No further than itself, in a line of text, where more would cover the words around it. */
  none: "",
};

interface LinkProps extends Props {
  /** How far around it takes taps on touch screens. */
  reach?: keyof typeof TOUCH_REACH;
}

/**
 * Someone's avatar as a link to their page, titled with their name and bio as the people directory lists
 * them now. It's Campfire's `.btn.avatar` (buttons.css): no border or padding, the avatar's corners,
 * a bot's round, white behind the image, which fills it, and darker under a mouse.
 */
export function AvatarLink({ user, className, square = false, lazy, label, reach = "finger" }: LinkProps) {
  const listed = useContext(PeopleContext).get(user.id);
  return (
    <PageLink
      href={personPath(user.id)}
      title={userTitle(listed ?? user)}
      className={cn(
        // One row and column the link's size: a row sized by its content would grow to a portrait photo's
        // height, past the link.
        "relative grid shrink-0 grid-cols-1 grid-rows-1 bg-background hover:not-active:brightness-70",
        square ? "rounded-[6px]" : "rounded-full",
        TOUCH_REACH[reach],
        className,
        isBot(user, listed) && "rounded-full",
      )}
    >
      <UserAvatar user={user} square={square} lazy={lazy} label={label} className="size-full" />
    </PageLink>
  );
}
