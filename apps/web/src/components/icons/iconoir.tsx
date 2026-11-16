import type { SVGProps } from "react";
import { cn } from "@/lib/utils";

// Iconoir's icons (iconoir.com), from the release pinned here: iconoir 7.12.1. The project's owner chose them for
// every icon Ember draws but those people pick for rooms and the rail (room-icon.tsx) and the picture of Chrome's
// View site information button in the setup help (campfire.tsx). iconoir/ holds their files from the package's
// icons/regular/, and iconoir/solid/ those from its icons/solid/, byte for byte, and icons.test.tsx checks each
// icon here against its file.

export type IconoirIconProps = SVGProps<SVGSVGElement>;

/**
 * Iconoir's 24px grid and 1.5 stroke, named `iconoir-<name>` as Iconoir's stylesheet names its icons. An icon
 * is hidden from screen readers unless it has an `aria-label`, as the setup help's pictures of buttons do.
 */
function IconoirIcon({ name, className, ...props }: IconoirIconProps & { name: string }) {
  const named = props["aria-label"] !== undefined;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      strokeWidth="1.5"
      fill="none"
      role={named ? "img" : undefined}
      aria-hidden={named ? undefined : "true"}
      focusable="false"
      className={cn(`iconoir-${name}`, className)}
      {...props}
    />
  );
}

/** How Iconoir draws a line: in the text's color, with round ends and corners. */
const LINE = { stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round" } as const;

/** A dot, which Iconoir fills as well as outlines. */
const DOT = { fill: "currentColor", ...LINE } as const;

/** A line with round ends whose corners Iconoir leaves sharp. */
const ROUND_ENDS = { stroke: "currentColor", strokeLinecap: "round" } as const;

/** An outline whose corners are curves already, so Iconoir gives it neither round ends nor round joins. */
const OUTLINE = { stroke: "currentColor", strokeWidth: "1.5" } as const;

export function ArrowDown(props: IconoirIconProps) {
  return (
    <IconoirIcon name="arrow-down" {...props}>
      <path d="M12 3L12 21M12 21L20.5 12.5M12 21L3.5 12.5" {...LINE} />
    </IconoirIcon>
  );
}

export function ArrowLeft(props: IconoirIconProps) {
  return (
    <IconoirIcon name="arrow-left" {...props}>
      <path d="M21 12L3 12M3 12L11.5 3.5M3 12L11.5 20.5" {...LINE} />
    </IconoirIcon>
  );
}

export function ArrowRight(props: IconoirIconProps) {
  return (
    <IconoirIcon name="arrow-right" {...props}>
      <path d="M3 12L21 12M21 12L12.5 3.5M21 12L12.5 20.5" {...LINE} />
    </IconoirIcon>
  );
}

export function ArrowUp(props: IconoirIconProps) {
  return (
    <IconoirIcon name="arrow-up" {...props}>
      <path d="M12 21L12 3M12 3L20.5 11.5M12 3L3.5 11.5" {...LINE} />
    </IconoirIcon>
  );
}

export function AtSign(props: IconoirIconProps) {
  return (
    <IconoirIcon name="at-sign" {...props}>
      <path
        d="M17.5 19.1245C15.9791 20.3003 14.0712 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12C21 17.5 15 17.5 15 14C15 12 15 8 15 8"
        {...LINE}
      />
      <path d="M15 12V10.5C15 9.11929 13.6569 8 12 8C10.3431 8 9 9.11929 9 10.5V12" {...LINE} />
      <path d="M15 12V13.5C15 14.8807 13.6569 16 12 16C10.3431 16 9 14.8807 9 13.5V12" {...LINE} />
    </IconoirIcon>
  );
}

export function Attachment(props: IconoirIconProps) {
  return (
    <IconoirIcon name="attachment" {...props}>
      <path
        d="M21.4383 11.6622L12.2483 20.8522C11.1225 21.9781 9.59552 22.6106 8.00334 22.6106C6.41115 22.6106 4.88418 21.9781 3.75834 20.8522C2.63249 19.7264 2 18.1994 2 16.6072C2 15.015 2.63249 13.4881 3.75834 12.3622L12.9483 3.17222C13.6989 2.42166 14.7169 2 15.7783 2C16.8398 2 17.8578 2.42166 18.6083 3.17222C19.3589 3.92279 19.7806 4.94077 19.7806 6.00222C19.7806 7.06368 19.3589 8.08166 18.6083 8.83222L9.40834 18.0222C9.03306 18.3975 8.52406 18.6083 7.99334 18.6083C7.46261 18.6083 6.95362 18.3975 6.57834 18.0222C6.20306 17.6469 5.99222 17.138 5.99222 16.6072C5.99222 16.0765 6.20306 15.5675 6.57834 15.1922L15.0683 6.71222"
        {...LINE}
      />
    </IconoirIcon>
  );
}

export function Bell(props: IconoirIconProps) {
  return (
    <IconoirIcon name="bell" {...props}>
      <path
        d="M18 8.4C18 6.70261 17.3679 5.07475 16.2426 3.87452C15.1174 2.67428 13.5913 2 12 2C10.4087 2 8.88258 2.67428 7.75736 3.87452C6.63214 5.07475 6 6.70261 6 8.4C6 15.8667 3 18 3 18H21C21 18 18 15.8667 18 8.4Z"
        {...LINE}
      />
      <path
        d="M13.73 21C13.5542 21.3031 13.3019 21.5547 12.9982 21.7295C12.6946 21.9044 12.3504 21.9965 12 21.9965C11.6496 21.9965 11.3054 21.9044 11.0018 21.7295C10.6982 21.5547 10.4458 21.3031 10.27 21"
        {...LINE}
      />
    </IconoirIcon>
  );
}

export function BellNotificationSolid(props: IconoirIconProps) {
  return (
    <IconoirIcon name="bell-notification-solid" {...props}>
      <path
        d="M14.752 1.91434C14.1218 2.7805 13.75 3.84683 13.75 5C13.75 7.83971 16.0046 10.1528 18.8214 10.247C18.8216 10.2508 18.8219 10.2546 18.8222 10.2583C18.8369 10.4557 18.852 10.6591 18.8726 10.855C19.1087 13.1025 19.6495 14.6443 20.1679 15.6582C20.5132 16.3334 20.8519 16.781 21.0922 17.0516C21.2125 17.1871 21.3088 17.2788 21.3696 17.3328C21.4 17.3599 21.4216 17.3775 21.4329 17.3865L21.4416 17.3933C21.7027 17.5833 21.8131 17.9196 21.7147 18.2278C21.6154 18.5386 21.3265 18.7496 21.0002 18.7496L3.00005 18.75C2.67373 18.75 2.38485 18.539 2.28559 18.2281C2.18718 17.9199 2.29755 17.5837 2.55863 17.3937L2.56735 17.3869C2.57869 17.3779 2.60028 17.3602 2.63069 17.3332C2.69148 17.2792 2.7877 17.1875 2.90804 17.052C3.14835 16.7814 3.48701 16.3338 3.8323 15.6585C4.52142 14.3109 5.25005 12.0306 5.25005 8.4C5.25005 6.51876 5.95021 4.70561 7.21026 3.36156C8.47184 2.01587 10.1937 1.25 12.0001 1.25C12.3823 1.25 12.7613 1.28434 13.1331 1.35139C13.3707 1.39421 14.1514 1.63742 14.752 1.91434Z"
        fillRule="evenodd"
        clipRule="evenodd"
        fill="currentColor"
      />
      <path
        d="M15.25 5C15.25 2.92893 16.9289 1.25 19 1.25C21.0711 1.25 22.75 2.92893 22.75 5C22.75 7.07107 21.0711 8.75 19 8.75C16.9289 8.75 15.25 7.07107 15.25 5Z"
        fillRule="evenodd"
        clipRule="evenodd"
        fill="currentColor"
      />
      <path
        d="M9.89369 20.3514C10.252 20.1435 10.7109 20.2655 10.9188 20.6238C11.0287 20.8132 11.1864 20.9705 11.3761 21.0798C11.5659 21.1891 11.781 21.2466 12 21.2466C12.219 21.2466 12.4342 21.1891 12.6239 21.0798C12.8137 20.9705 12.9714 20.8132 13.0813 20.6238C13.2891 20.2655 13.7481 20.1435 14.1063 20.3514C14.4646 20.5592 14.5866 21.0182 14.3788 21.3765C14.137 21.7932 13.7901 22.1391 13.3726 22.3796C12.9551 22.62 12.4818 22.7466 12 22.7466C11.5183 22.7466 11.0449 22.62 10.6275 22.3796C10.21 22.1391 9.86301 21.7932 9.62127 21.3765C9.41343 21.0182 9.5354 20.5592 9.89369 20.3514Z"
        fillRule="evenodd"
        clipRule="evenodd"
        fill="currentColor"
      />
    </IconoirIcon>
  );
}

export function BellOff(props: IconoirIconProps) {
  return (
    <IconoirIcon name="bell-off" {...props}>
      <path d="M6.27049 6.5C6.09277 7.10971 6 7.74975 6 8.4C6 15.8667 3 18 3 18H18" {...LINE} />
      <path
        d="M7.75732 3.87452C8.88254 2.67428 10.4087 2 12 2C13.5913 2 15.1174 2.67428 16.2426 3.87452C17.3678 5.07475 18 6.70261 18 8.4C18 15.8667 21 18 21 18"
        {...LINE}
      />
      <path
        d="M13.73 21C13.5542 21.3031 13.3019 21.5547 12.9982 21.7295C12.6946 21.9044 12.3504 21.9965 12 21.9965C11.6496 21.9965 11.3054 21.9044 11.0018 21.7295C10.6982 21.5547 10.4458 21.3031 10.27 21"
        {...LINE}
      />
      <path d="M3 3L21 21" {...LINE} />
    </IconoirIcon>
  );
}

export function Box(props: IconoirIconProps) {
  return (
    <IconoirIcon name="box" {...props}>
      <path d="M10 12L14 12" {...LINE} />
      <path d="M3 3L21 3" {...LINE} />
      <path d="M21 7V20.4C21 20.7314 20.7314 21 20.4 21H3.6C3.26863 21 3 20.7314 3 20.4V7" {...LINE} />
    </IconoirIcon>
  );
}

export function BrainElectricity(props: IconoirIconProps) {
  return (
    <IconoirIcon name="brain-electricity" {...props}>
      <path d="M7 14C5.34315 14 4 15.3431 4 17C4 18.6569 5.34315 20 7 20C7.35064 20 7.68722 19.9398 8 19.8293" {...LINE} />
      <path d="M4.26392 15.6046C2.9243 14.9582 2.00004 13.587 2.00004 12C2.00004 10.7883 2.53877 9.70251 3.38978 8.96898" {...LINE} />
      <path d="M3.42053 8.8882C3.1549 8.49109 3 8.01363 3 7.5C3 6.11929 4.11929 5 5.5 5C6.06291 5 6.58237 5.18604 7.00024 5.5" {...LINE} />
      <path d="M7.23769 5.56533C7.08524 5.24215 7 4.88103 7 4.5C7 3.11929 8.11929 2 9.5 2C10.8807 2 12 3.11929 12 4.5V20" {...LINE} />
      <path d="M8 20C8 21.1046 8.89543 22 10 22C11.1046 22 12 21.1046 12 20" {...LINE} />
      <path d="M12 7C12 8.65685 13.3431 10 15 10" {...LINE} />
      <path d="M20.6102 8.96898C21.4612 9.70251 22 10.7883 22 12C22 12.7031 21.8186 13.3638 21.5 13.9379" {...LINE} />
      <path d="M20.5795 8.8882C20.8451 8.49109 21 8.01363 21 7.5C21 6.11929 19.8807 5 18.5 5C17.9371 5 17.4176 5.18604 16.9998 5.5" {...LINE} />
      <path d="M12 4.5C12 3.11929 13.1193 2 14.5 2C15.8807 2 17 3.11929 17 4.5C17 4.88103 16.9148 5.24215 16.7623 5.56533" {...LINE} />
      <path d="M14 22C12.8954 22 12 21.1046 12 20" {...LINE} />
      <path d="M18.6667 16L17 19H21L19.3333 22" {...LINE} />
    </IconoirIcon>
  );
}

export function Camera(props: IconoirIconProps) {
  return (
    <IconoirIcon name="camera" {...props}>
      <path
        d="M2 19V9C2 7.89543 2.89543 7 4 7H4.5C5.12951 7 5.72229 6.70361 6.1 6.2L8.32 3.24C8.43331 3.08892 8.61115 3 8.8 3H15.2C15.3889 3 15.5667 3.08892 15.68 3.24L17.9 6.2C18.2777 6.70361 18.8705 7 19.5 7H20C21.1046 7 22 7.89543 22 9V19C22 20.1046 21.1046 21 20 21H4C2.89543 21 2 20.1046 2 19Z"
        {...LINE}
      />
      <path d="M12 17C14.2091 17 16 15.2091 16 13C16 10.7909 14.2091 9 12 9C9.79086 9 8 10.7909 8 13C8 15.2091 9.79086 17 12 17Z" {...LINE} />
    </IconoirIcon>
  );
}

export function ChatBubbleEmpty(props: IconoirIconProps) {
  return (
    <IconoirIcon name="chat-bubble-empty" {...props}>
      <path
        d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 13.8214 2.48697 15.5291 3.33782 17L2.5 21.5L7 20.6622C8.47087 21.513 10.1786 22 12 22Z"
        {...LINE}
      />
    </IconoirIcon>
  );
}

export function ChatBubbleQuestion(props: IconoirIconProps) {
  return (
    <IconoirIcon name="chat-bubble-question" {...props}>
      <path d="M9 9C9 5.49997 14.5 5.5 14.5 9C14.5 11.5 12 10.9999 12 13.9999" {...LINE} />
      <path d="M12 18.01L12.01 17.9989" {...LINE} />
      <path
        d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 13.8214 2.48697 15.5291 3.33782 17L2.5 21.5L7 20.6622C8.47087 21.513 10.1786 22 12 22Z"
        {...LINE}
      />
    </IconoirIcon>
  );
}

export function ChatLines(props: IconoirIconProps) {
  return (
    <IconoirIcon name="chat-lines" {...props}>
      <path d="M8 10L12 10L16 10" {...LINE} />
      <path d="M8 14L10 14L12 14" {...LINE} />
      <path
        d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 13.8214 2.48697 15.5291 3.33782 17L2.5 21.5L7 20.6622C8.47087 21.513 10.1786 22 12 22Z"
        {...LINE}
      />
    </IconoirIcon>
  );
}

export function ChatPlusIn(props: IconoirIconProps) {
  return (
    <IconoirIcon name="chat-plus-in" {...props}>
      <path d="M9 12H12M15 12H12M12 12V9M12 12V15" {...LINE} />
      <path
        d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 13.8214 2.48697 15.5291 3.33782 17L2.5 21.5L7 20.6622C8.47087 21.513 10.1786 22 12 22Z"
        {...LINE}
      />
    </IconoirIcon>
  );
}

export function CheckCircle(props: IconoirIconProps) {
  return (
    <IconoirIcon name="check-circle" {...props}>
      <path d="M7 12.5L10 15.5L17 8.5" {...LINE} />
      <path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z" {...LINE} />
    </IconoirIcon>
  );
}

export function ClockRotateRight(props: IconoirIconProps) {
  return (
    <IconoirIcon name="clock-rotate-right" {...props}>
      <path d="M12 6L12 12L18 12" {...LINE} />
      <path
        d="M21.8883 10.5C21.1645 5.68874 17.013 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22C16.1006 22 19.6248 19.5318 21.1679 16"
        {...LINE}
      />
      <path d="M17 16H21.4C21.7314 16 22 16.2686 22 16.6V21" {...LINE} />
    </IconoirIcon>
  );
}

export function Collapse(props: IconoirIconProps) {
  return (
    <IconoirIcon name="collapse" {...props}>
      <path d="M20 20L15 15M15 15V19M15 15H19" {...LINE} />
      <path d="M4 20L9 15M9 15V19M9 15H5" {...LINE} />
      <path d="M20 4L15 9M15 9V5M15 9H19" {...LINE} />
      <path d="M4 4L9 9M9 9V5M9 9H5" {...LINE} />
    </IconoirIcon>
  );
}

export function Community(props: IconoirIconProps) {
  return (
    <IconoirIcon name="community" {...props}>
      <path d="M7 18V17C7 14.2386 9.23858 12 12 12V12C14.7614 12 17 14.2386 17 17V18" {...LINE} />
      <path d="M1 18V17C1 15.3431 2.34315 14 4 14V14" {...LINE} />
      <path d="M23 18V17C23 15.3431 21.6569 14 20 14V14" {...LINE} />
      <path d="M12 12C13.6569 12 15 10.6569 15 9C15 7.34315 13.6569 6 12 6C10.3431 6 9 7.34315 9 9C9 10.6569 10.3431 12 12 12Z" {...LINE} />
      <path d="M4 14C5.10457 14 6 13.1046 6 12C6 10.8954 5.10457 10 4 10C2.89543 10 2 10.8954 2 12C2 13.1046 2.89543 14 4 14Z" {...LINE} />
      <path d="M20 14C21.1046 14 22 13.1046 22 12C22 10.8954 21.1046 10 20 10C18.8954 10 18 10.8954 18 12C18 13.1046 18.8954 14 20 14Z" {...LINE} />
    </IconoirIcon>
  );
}

export function Computer(props: IconoirIconProps) {
  return (
    <IconoirIcon name="computer" {...props}>
      <path d="M2 21L17 21" {...LINE} />
      <path d="M21 21L22 21" {...LINE} />
      <path
        d="M2 16.4V3.6C2 3.26863 2.26863 3 2.6 3H21.4C21.7314 3 22 3.26863 22 3.6V16.4C22 16.7314 21.7314 17 21.4 17H2.6C2.26863 17 2 16.7314 2 16.4Z"
        {...OUTLINE}
      />
    </IconoirIcon>
  );
}

export function Copy(props: IconoirIconProps) {
  return (
    <IconoirIcon name="copy" {...props}>
      <path
        d="M19.4 20H9.6C9.26863 20 9 19.7314 9 19.4V9.6C9 9.26863 9.26863 9 9.6 9H19.4C19.7314 9 20 9.26863 20 9.6V19.4C20 19.7314 19.7314 20 19.4 20Z"
        {...LINE}
      />
      <path d="M15 9V4.6C15 4.26863 14.7314 4 14.4 4H4.6C4.26863 4 4 4.26863 4 4.6V14.4C4 14.7314 4.26863 15 4.6 15H9" {...LINE} />
    </IconoirIcon>
  );
}

export function Crown(props: IconoirIconProps) {
  return (
    <IconoirIcon name="crown" {...props}>
      <path d="M19.2 17L21 7L14.7 10L12 7L9.3 10L3 7L4.8 17H19.2Z" {...LINE} />
    </IconoirIcon>
  );
}

export function DotsGrid3x3(props: IconoirIconProps) {
  return (
    <IconoirIcon name="dots-grid-3x3" {...props}>
      <path d="M5.5 6C5.77614 6 6 5.77614 6 5.5C6 5.22386 5.77614 5 5.5 5C5.22386 5 5 5.22386 5 5.5C5 5.77614 5.22386 6 5.5 6Z" {...DOT} />
      <path
        d="M5.5 12.5C5.77614 12.5 6 12.2761 6 12C6 11.7239 5.77614 11.5 5.5 11.5C5.22386 11.5 5 11.7239 5 12C5 12.2761 5.22386 12.5 5.5 12.5Z"
        {...DOT}
      />
      <path d="M5.5 19C5.77614 19 6 18.7761 6 18.5C6 18.2239 5.77614 18 5.5 18C5.22386 18 5 18.2239 5 18.5C5 18.7761 5.22386 19 5.5 19Z" {...DOT} />
      <path
        d="M12 6C12.2761 6 12.5 5.77614 12.5 5.5C12.5 5.22386 12.2761 5 12 5C11.7239 5 11.5 5.22386 11.5 5.5C11.5 5.77614 11.7239 6 12 6Z"
        {...DOT}
      />
      <path
        d="M12 12.5C12.2761 12.5 12.5 12.2761 12.5 12C12.5 11.7239 12.2761 11.5 12 11.5C11.7239 11.5 11.5 11.7239 11.5 12C11.5 12.2761 11.7239 12.5 12 12.5Z"
        {...DOT}
      />
      <path
        d="M12 19C12.2761 19 12.5 18.7761 12.5 18.5C12.5 18.2239 12.2761 18 12 18C11.7239 18 11.5 18.2239 11.5 18.5C11.5 18.7761 11.7239 19 12 19Z"
        {...DOT}
      />
      <path d="M18.5 6C18.7761 6 19 5.77614 19 5.5C19 5.22386 18.7761 5 18.5 5C18.2239 5 18 5.22386 18 5.5C18 5.77614 18.2239 6 18.5 6Z" {...DOT} />
      <path
        d="M18.5 12.5C18.7761 12.5 19 12.2761 19 12C19 11.7239 18.7761 11.5 18.5 11.5C18.2239 11.5 18 11.7239 18 12C18 12.2761 18.2239 12.5 18.5 12.5Z"
        {...DOT}
      />
      <path
        d="M18.5 19C18.7761 19 19 18.7761 19 18.5C19 18.2239 18.7761 18 18.5 18C18.2239 18 18 18.2239 18 18.5C18 18.7761 18.2239 19 18.5 19Z"
        {...DOT}
      />
    </IconoirIcon>
  );
}

export function Download(props: IconoirIconProps) {
  return (
    <IconoirIcon name="download" {...props}>
      <path d="M6 20L18 20" {...LINE} />
      <path d="M12 4V16M12 16L15.5 12.5M12 16L8.5 12.5" {...LINE} />
    </IconoirIcon>
  );
}

export function DownloadDataWindow(props: IconoirIconProps) {
  return (
    <IconoirIcon name="download-data-window" {...props}>
      <path d="M14 21H4C2.89543 21 2 20.1046 2 19V5C2 3.89543 2.89543 3 4 3H20C21.1046 3 22 3.89543 22 5V14" {...ROUND_ENDS} />
      <path d="M2 7L22 7" {...LINE} />
      <path d="M5 5.01L5.01 4.99889" {...LINE} />
      <path d="M8 5.01L8.01 4.99889" {...LINE} />
      <path d="M11 5.01L11.01 4.99889" {...LINE} />
      <path d="M19.5 16V22M19.5 22L17 19.5M19.5 22L22 19.5" {...LINE} />
    </IconoirIcon>
  );
}

export function Edit(props: IconoirIconProps) {
  return (
    <IconoirIcon name="edit" {...props}>
      <path d="M3 21L12 21H21" {...LINE} />
      <path
        d="M12.2218 5.82839L15.0503 2.99996L20 7.94971L17.1716 10.7781M12.2218 5.82839L6.61522 11.435C6.42769 11.6225 6.32233 11.8769 6.32233 12.1421L6.32233 16.6776L10.8579 16.6776C11.1231 16.6776 11.3774 16.5723 11.565 16.3847L17.1716 10.7781M12.2218 5.82839L17.1716 10.7781"
        {...LINE}
      />
    </IconoirIcon>
  );
}

export function EditPencil(props: IconoirIconProps) {
  return (
    <IconoirIcon name="edit-pencil" {...props}>
      <path
        d="M14.3632 5.65156L15.8431 4.17157C16.6242 3.39052 17.8905 3.39052 18.6716 4.17157L20.0858 5.58579C20.8668 6.36683 20.8668 7.63316 20.0858 8.41421L18.6058 9.8942M14.3632 5.65156L4.74749 15.2672C4.41542 15.5993 4.21079 16.0376 4.16947 16.5054L3.92738 19.2459C3.87261 19.8659 4.39148 20.3848 5.0115 20.33L7.75191 20.0879C8.21972 20.0466 8.65806 19.8419 8.99013 19.5099L18.6058 9.8942M14.3632 5.65156L18.6058 9.8942"
        {...LINE}
      />
    </IconoirIcon>
  );
}

export function Emoji(props: IconoirIconProps) {
  return (
    <IconoirIcon name="emoji" {...props}>
      <path d="M12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12C22 17.5228 17.5228 22 12 22Z" {...LINE} />
      <path d="M16.5 14.5C16.5 14.5 15 16.5 12 16.5C9 16.5 7.5 14.5 7.5 14.5" {...LINE} />
      <path d="M15.5 9C15.2239 9 15 8.77614 15 8.5C15 8.22386 15.2239 8 15.5 8C15.7761 8 16 8.22386 16 8.5C16 8.77614 15.7761 9 15.5 9Z" {...DOT} />
      <path d="M8.5 9C8.22386 9 8 8.77614 8 8.5C8 8.22386 8.22386 8 8.5 8C8.77614 8 9 8.22386 9 8.5C9 8.77614 8.77614 9 8.5 9Z" {...DOT} />
    </IconoirIcon>
  );
}

export function Expand(props: IconoirIconProps) {
  return (
    <IconoirIcon name="expand" {...props}>
      <path d="M9 9L4 4M4 4V8M4 4H8" {...LINE} />
      <path d="M15 9L20 4M20 4V8M20 4H16" {...LINE} />
      <path d="M9 15L4 20M4 20V16M4 20H8" {...LINE} />
      <path d="M15 15L20 20M20 20V16M20 20H16" {...LINE} />
    </IconoirIcon>
  );
}

export function Eye(props: IconoirIconProps) {
  return (
    <IconoirIcon name="eye" {...props}>
      <path d="M3 13C6.6 5 17.4 5 21 13" {...LINE} />
      <path d="M12 17C10.3431 17 9 15.6569 9 14C9 12.3431 10.3431 11 12 11C13.6569 11 15 12.3431 15 14C15 15.6569 13.6569 17 12 17Z" {...LINE} />
    </IconoirIcon>
  );
}

export function EyeClosed(props: IconoirIconProps) {
  return (
    <IconoirIcon name="eye-closed" {...props}>
      <path d="M19.5 16L17.0248 12.6038" {...LINE} />
      <path d="M12 17.5V14" {...LINE} />
      <path d="M4.5 16L6.96895 12.6124" {...LINE} />
      <path d="M3 8C6.6 16 17.4 16 21 8" {...LINE} />
    </IconoirIcon>
  );
}

export function FilterList(props: IconoirIconProps) {
  return (
    <IconoirIcon name="filter-list" {...props}>
      <path d="M3 6H21" {...LINE} />
      <path d="M7 12L17 12" {...LINE} />
      <path d="M11 18L13 18" {...LINE} />
    </IconoirIcon>
  );
}

export function GridPlus(props: IconoirIconProps) {
  return (
    <IconoirIcon name="grid-plus" {...props}>
      <path d="M13.9922 17H16.9922M19.9922 17H16.9922M16.9922 17V14M16.9922 17V20" {...LINE} />
      <path
        d="M4 9.4V4.6C4 4.26863 4.26863 4 4.6 4H9.4C9.73137 4 10 4.26863 10 4.6V9.4C10 9.73137 9.73137 10 9.4 10H4.6C4.26863 10 4 9.73137 4 9.4Z"
        {...OUTLINE}
      />
      <path
        d="M4 19.4V14.6C4 14.2686 4.26863 14 4.6 14H9.4C9.73137 14 10 14.2686 10 14.6V19.4C10 19.7314 9.73137 20 9.4 20H4.6C4.26863 20 4 19.7314 4 19.4Z"
        {...OUTLINE}
      />
      <path
        d="M14 9.4V4.6C14 4.26863 14.2686 4 14.6 4H19.4C19.7314 4 20 4.26863 20 4.6V9.4C20 9.73137 19.7314 10 19.4 10H14.6C14.2686 10 14 9.73137 14 9.4Z"
        {...OUTLINE}
      />
    </IconoirIcon>
  );
}

export function Group(props: IconoirIconProps) {
  return (
    <IconoirIcon name="group" {...props}>
      <path d="M1 20V19C1 15.134 4.13401 12 8 12V12C11.866 12 15 15.134 15 19V20" {...ROUND_ENDS} />
      <path d="M13 14V14C13 11.2386 15.2386 9 18 9V9C20.7614 9 23 11.2386 23 14V14.5" {...ROUND_ENDS} />
      <path d="M8 12C10.2091 12 12 10.2091 12 8C12 5.79086 10.2091 4 8 4C5.79086 4 4 5.79086 4 8C4 10.2091 5.79086 12 8 12Z" {...LINE} />
      <path d="M18 9C19.6569 9 21 7.65685 21 6C21 4.34315 19.6569 3 18 3C16.3431 3 15 4.34315 15 6C15 7.65685 16.3431 9 18 9Z" {...LINE} />
    </IconoirIcon>
  );
}

export function HalfMoon(props: IconoirIconProps) {
  return (
    <IconoirIcon name="half-moon" {...props}>
      <path
        d="M3 11.5066C3 16.7497 7.25034 21 12.4934 21C16.2209 21 19.4466 18.8518 21 15.7259C12.4934 15.7259 8.27411 11.5066 8.27411 3C5.14821 4.55344 3 7.77915 3 11.5066Z"
        {...LINE}
      />
    </IconoirIcon>
  );
}

export function Hashtag(props: IconoirIconProps) {
  return (
    <IconoirIcon name="hashtag" {...props}>
      <path d="M10 3L6 21" {...ROUND_ENDS} />
      <path d="M20.5 16H2.5" {...ROUND_ENDS} />
      <path d="M22 7H4" {...ROUND_ENDS} />
      <path d="M18 3L14 21" {...ROUND_ENDS} />
    </IconoirIcon>
  );
}

export function Headset(props: IconoirIconProps) {
  return (
    <IconoirIcon name="headset" {...props}>
      <path
        d="M4 13.4998L3.51493 13.6211C2.62459 13.8437 2 14.6437 2 15.5614V17.4383C2 18.356 2.62459 19.156 3.51493 19.3786L5.25448 19.8135C5.63317 19.9081 6 19.6217 6 19.2314V13.7683C6 13.378 5.63317 13.0916 5.25448 13.1862L4 13.4998ZM4 13.4998V13C4 8.02944 7.58172 4 12 4C16.4183 4 20 8.02944 20 13V13.5M20 13.5L20.4851 13.6211C21.3754 13.8437 22 14.6437 22 15.5614V17.4383C22 18.356 21.3754 19.156 20.4851 19.3786L18.7455 19.8135C18.3668 19.9081 18 19.6217 18 19.2314V13.7683C18 13.378 18.3668 13.0916 18.7455 13.1862L20 13.5Z"
        {...LINE}
      />
    </IconoirIcon>
  );
}

export function Home(props: IconoirIconProps) {
  return (
    <IconoirIcon name="home" {...props}>
      <path d="M2 8L11.7317 3.13416C11.9006 3.04971 12.0994 3.0497 12.2683 3.13416L22 8" {...LINE} />
      <path d="M20 11V19C20 20.1046 19.1046 21 18 21H6C4.89543 21 4 20.1046 4 19V11" {...LINE} />
    </IconoirIcon>
  );
}

export function Internet(props: IconoirIconProps) {
  return (
    <IconoirIcon name="internet" {...props}>
      <path d="M22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22" {...LINE} />
      <path d="M13 2.04932C13 2.04932 16 5.99994 16 11.9999" {...LINE} />
      <path d="M11 21.9506C11 21.9506 8 17.9999 8 11.9999C8 5.99994 11 2.04932 11 2.04932" {...LINE} />
      <path d="M2.62964 15.5H12" {...LINE} />
      <path d="M2.62964 8.5H21.3704" {...LINE} />
      <path
        d="M21.8789 17.9174C22.3727 18.2211 22.3423 18.9604 21.8337 19.0181L19.2671 19.309L18.1159 21.6213C17.8878 22.0795 17.1827 21.8552 17.0661 21.2873L15.8108 15.1713C15.7123 14.6913 16.1437 14.3892 16.561 14.646L21.8789 17.9174Z"
        fillRule="evenodd"
        clipRule="evenodd"
        stroke="currentColor"
      />
    </IconoirIcon>
  );
}

export function Laptop(props: IconoirIconProps) {
  return (
    <IconoirIcon name="laptop" {...props}>
      <path
        d="M3.2 14.2222V4C3.2 2.89543 4.09543 2 5.2 2H18.8C19.9046 2 20.8 2.89543 20.8 4V14.2222M3.2 14.2222H20.8M3.2 14.2222L1.71969 19.4556C1.35863 20.7321 2.31762 22 3.64418 22H20.3558C21.6824 22 22.6414 20.7321 22.2803 19.4556L20.8 14.2222"
        {...OUTLINE}
      />
      <path d="M11 19L13 19" {...LINE} />
    </IconoirIcon>
  );
}

export function Link(props: IconoirIconProps) {
  return (
    <IconoirIcon name="link" {...props}>
      <path
        d="M14 11.9976C14 9.5059 11.683 7 8.85714 7C8.52241 7 7.41904 7.00001 7.14286 7.00001C4.30254 7.00001 2 9.23752 2 11.9976C2 14.376 3.70973 16.3664 6 16.8714C6.36756 16.9525 6.75006 16.9952 7.14286 16.9952"
        {...LINE}
      />
      <path
        d="M10 11.9976C10 14.4893 12.317 16.9952 15.1429 16.9952C15.4776 16.9952 16.581 16.9952 16.8571 16.9952C19.6975 16.9952 22 14.7577 22 11.9976C22 9.6192 20.2903 7.62884 18 7.12383C17.6324 7.04278 17.2499 6.99999 16.8571 6.99999"
        {...LINE}
      />
    </IconoirIcon>
  );
}

export function Lock(props: IconoirIconProps) {
  return (
    <IconoirIcon name="lock" {...props}>
      <path
        d="M16 12H17.4C17.7314 12 18 12.2686 18 12.6V19.4C18 19.7314 17.7314 20 17.4 20H6.6C6.26863 20 6 19.7314 6 19.4V12.6C6 12.2686 6.26863 12 6.6 12H8M16 12V8C16 6.66667 15.2 4 12 4C8.8 4 8 6.66667 8 8V12M16 12H8"
        {...LINE}
      />
    </IconoirIcon>
  );
}

export function LogOut(props: IconoirIconProps) {
  return (
    <IconoirIcon name="log-out" {...props}>
      <path d="M12 12H19M19 12L16 15M19 12L16 9" {...LINE} />
      <path
        d="M19 6V5C19 3.89543 18.1046 3 17 3H7C5.89543 3 5 3.89543 5 5V19C5 20.1046 5.89543 21 7 21H17C18.1046 21 19 20.1046 19 19V18"
        {...LINE}
      />
    </IconoirIcon>
  );
}

export function Mail(props: IconoirIconProps) {
  return (
    <IconoirIcon name="mail" {...props}>
      <path d="M7 9L12 12.5L17 9" {...LINE} />
      <path
        d="M2 17V7C2 5.89543 2.89543 5 4 5H20C21.1046 5 22 5.89543 22 7V17C22 18.1046 21.1046 19 20 19H4C2.89543 19 2 18.1046 2 17Z"
        {...OUTLINE}
      />
    </IconoirIcon>
  );
}

export function Menu(props: IconoirIconProps) {
  return (
    <IconoirIcon name="menu" {...props}>
      <path d="M3 5H21" {...LINE} />
      <path d="M3 12H21" {...LINE} />
      <path d="M3 19H21" {...LINE} />
    </IconoirIcon>
  );
}

export function MessageText(props: IconoirIconProps) {
  return (
    <IconoirIcon name="message-text" {...props}>
      <path d="M7 12L17 12" {...LINE} />
      <path d="M7 8L13 8" {...LINE} />
      <path
        d="M3 20.2895V5C3 3.89543 3.89543 3 5 3H19C20.1046 3 21 3.89543 21 5V15C21 16.1046 20.1046 17 19 17H7.96125C7.35368 17 6.77906 17.2762 6.39951 17.7506L4.06852 20.6643C3.71421 21.1072 3 20.8567 3 20.2895Z"
        {...OUTLINE}
      />
    </IconoirIcon>
  );
}

export function Microphone(props: IconoirIconProps) {
  return (
    <IconoirIcon name="microphone" {...props}>
      <rect x="9" y="2" width="6" height="12" rx="3" {...OUTLINE} />
      <path d="M5 10V11C5 14.866 8.13401 18 12 18V18V18C15.866 18 19 14.866 19 11V10" {...LINE} />
      <path d="M12 18V22M12 22H9M12 22H15" {...LINE} />
    </IconoirIcon>
  );
}

export function MicrophoneMute(props: IconoirIconProps) {
  return (
    <IconoirIcon name="microphone-mute" {...props}>
      <path d="M3 3L21 21" {...LINE} />
      <path d="M9 9V9C9 11.7614 11.2386 14 14 14V14M15 10.5V5C15 3.34315 13.6569 2 12 2V2C10.3431 2 9 3.34315 9 5V5.5" {...LINE} />
      <path d="M5 10V11C5 14.866 8.13401 18 12 18V18V18C15.866 18 19 14.866 19 11V10" {...LINE} />
      <path d="M12 18V22M12 22H9M12 22H15" {...LINE} />
    </IconoirIcon>
  );
}

export function Minus(props: IconoirIconProps) {
  return (
    <IconoirIcon name="minus" {...props}>
      <path d="M6 12H18" {...LINE} />
    </IconoirIcon>
  );
}

export function ModernTv(props: IconoirIconProps) {
  return (
    <IconoirIcon name="modern-tv" {...props}>
      <path d="M7 21L17 21" {...LINE} />
      <path
        d="M2 16.4V3.6C2 3.26863 2.26863 3 2.6 3H21.4C21.7314 3 22 3.26863 22 3.6V16.4C22 16.7314 21.7314 17 21.4 17H2.6C2.26863 17 2 16.7314 2 16.4Z"
        {...OUTLINE}
      />
    </IconoirIcon>
  );
}

export function MoreHoriz(props: IconoirIconProps) {
  return (
    <IconoirIcon name="more-horiz" {...props}>
      <path
        d="M20 12.5C20.2761 12.5 20.5 12.2761 20.5 12C20.5 11.7239 20.2761 11.5 20 11.5C19.7239 11.5 19.5 11.7239 19.5 12C19.5 12.2761 19.7239 12.5 20 12.5Z"
        {...DOT}
      />
      <path
        d="M12 12.5C12.2761 12.5 12.5 12.2761 12.5 12C12.5 11.7239 12.2761 11.5 12 11.5C11.7239 11.5 11.5 11.7239 11.5 12C11.5 12.2761 11.7239 12.5 12 12.5Z"
        {...DOT}
      />
      <path
        d="M4 12.5C4.27614 12.5 4.5 12.2761 4.5 12C4.5 11.7239 4.27614 11.5 4 11.5C3.72386 11.5 3.5 11.7239 3.5 12C3.5 12.2761 3.72386 12.5 4 12.5Z"
        {...DOT}
      />
    </IconoirIcon>
  );
}

export function MoreVert(props: IconoirIconProps) {
  return (
    <IconoirIcon name="more-vert" {...props}>
      <path
        d="M12 12.5C12.2761 12.5 12.5 12.2761 12.5 12C12.5 11.7239 12.2761 11.5 12 11.5C11.7239 11.5 11.5 11.7239 11.5 12C11.5 12.2761 11.7239 12.5 12 12.5Z"
        {...DOT}
      />
      <path
        d="M12 20.5C12.2761 20.5 12.5 20.2761 12.5 20C12.5 19.7239 12.2761 19.5 12 19.5C11.7239 19.5 11.5 19.7239 11.5 20C11.5 20.2761 11.7239 20.5 12 20.5Z"
        {...DOT}
      />
      <path
        d="M12 4.5C12.2761 4.5 12.5 4.27614 12.5 4C12.5 3.72386 12.2761 3.5 12 3.5C11.7239 3.5 11.5 3.72386 11.5 4C11.5 4.27614 11.7239 4.5 12 4.5Z"
        {...DOT}
      />
    </IconoirIcon>
  );
}

export function MultiBubble(props: IconoirIconProps) {
  return (
    <IconoirIcon name="multi-bubble" {...props}>
      <path
        d="M7.5 22C10.5376 22 13 19.5376 13 16.5C13 13.4624 10.5376 11 7.5 11C4.46243 11 2 13.4624 2 16.5C2 17.5018 2.26783 18.441 2.7358 19.25L2.275 21.725L4.75 21.2642C5.55898 21.7322 6.49821 22 7.5 22Z"
        {...LINE}
      />
      <path
        d="M15.2824 17.8978C16.2587 17.7405 17.1758 17.4065 18 16.9297L21.6 17.6L20.9297 14C21.6104 12.8233 22 11.4571 22 10C22 5.58172 18.4183 2 14 2C9.97262 2 6.64032 4.97598 6.08221 8.84884"
        {...LINE}
      />
    </IconoirIcon>
  );
}

export function NavArrowDown(props: IconoirIconProps) {
  return (
    <IconoirIcon name="nav-arrow-down" {...props}>
      <path d="M6 9L12 15L18 9" {...LINE} />
    </IconoirIcon>
  );
}

export function NavArrowRight(props: IconoirIconProps) {
  return (
    <IconoirIcon name="nav-arrow-right" {...props}>
      <path d="M9 6L15 12L9 18" {...LINE} />
    </IconoirIcon>
  );
}

export function NavArrowUp(props: IconoirIconProps) {
  return (
    <IconoirIcon name="nav-arrow-up" {...props}>
      <path d="M6 15L12 9L18 15" {...LINE} />
    </IconoirIcon>
  );
}

export function Page(props: IconoirIconProps) {
  return (
    <IconoirIcon name="page" {...props}>
      <path
        d="M4 21.4V2.6C4 2.26863 4.26863 2 4.6 2H16.2515C16.4106 2 16.5632 2.06321 16.6757 2.17574L19.8243 5.32426C19.9368 5.43679 20 5.5894 20 5.74853V21.4C20 21.7314 19.7314 22 19.4 22H4.6C4.26863 22 4 21.7314 4 21.4Z"
        {...LINE}
      />
      <path d="M8 10L16 10" {...LINE} />
      <path d="M8 18L16 18" {...LINE} />
      <path d="M8 14L12 14" {...LINE} />
      <path d="M16 2V5.4C16 5.73137 16.2686 6 16.6 6H20" {...LINE} />
    </IconoirIcon>
  );
}

export function Palette(props: IconoirIconProps) {
  return (
    <IconoirIcon name="palette" {...props}>
      <path
        d="M20.5096 9.54C20.4243 9.77932 20.2918 9.99909 20.12 10.1863C19.9483 10.3735 19.7407 10.5244 19.5096 10.63C18.2796 11.1806 17.2346 12.0745 16.5002 13.2045C15.7659 14.3345 15.3733 15.6524 15.3696 17C15.3711 17.4701 15.418 17.9389 15.5096 18.4C15.5707 18.6818 15.5747 18.973 15.5215 19.2564C15.4682 19.5397 15.3588 19.8096 15.1996 20.05C15.0649 20.2604 14.8877 20.4403 14.6793 20.5781C14.4709 20.7158 14.2359 20.8085 13.9896 20.85C13.4554 20.9504 12.9131 21.0006 12.3696 21C11.1638 21.0006 9.97011 20.7588 8.85952 20.2891C7.74893 19.8194 6.74405 19.1314 5.90455 18.2657C5.06506 17.4001 4.40807 16.3747 3.97261 15.2502C3.53714 14.1257 3.33208 12.9252 3.36959 11.72C3.4472 9.47279 4.3586 7.33495 5.92622 5.72296C7.49385 4.11097 9.60542 3.14028 11.8496 3H12.3596C14.0353 3.00042 15.6777 3.46869 17.1017 4.35207C18.5257 5.23544 19.6748 6.49885 20.4196 8C20.6488 8.47498 20.6812 9.02129 20.5096 9.52V9.54Z"
        {...OUTLINE}
      />
      <path d="M8 16.01L8.01 15.9989" {...LINE} />
      <path d="M6 12.01L6.01 11.9989" {...LINE} />
      <path d="M8 8.01L8.01 7.99889" {...LINE} />
      <path d="M12 6.01L12.01 5.99889" {...LINE} />
      <path d="M16 8.01L16.01 7.99889" {...LINE} />
    </IconoirIcon>
  );
}

export function Plus(props: IconoirIconProps) {
  return (
    <IconoirIcon name="plus" {...props}>
      <path d="M6 12H12M18 12H12M12 12V6M12 12V18" {...LINE} />
    </IconoirIcon>
  );
}

export function Prohibition(props: IconoirIconProps) {
  return (
    <IconoirIcon name="prohibition" {...props}>
      <path
        d="M19.1414 5C17.3265 3.14864 14.7974 2 12 2C6.47715 2 2 6.47715 2 12C2 14.7255 3.09032 17.1962 4.85857 19M19.1414 5C20.9097 6.80375 22 9.27455 22 12C22 17.5228 17.5228 22 12 22C9.20261 22 6.67349 20.8514 4.85857 19M19.1414 5L4.85857 19"
        {...LINE}
      />
    </IconoirIcon>
  );
}

export function QrCode(props: IconoirIconProps) {
  return (
    <IconoirIcon name="qr-code" {...props}>
      <path d="M15 12L15 15" {...LINE} />
      <path d="M12 3V6" {...LINE} />
      <path d="M18 12L18 15" {...LINE} />
      <path d="M12 18L21 18" {...LINE} />
      <path d="M18 21H21" {...LINE} />
      <path d="M6 12H9" {...LINE} />
      <path d="M6 6.01111L6.01 6" {...LINE} />
      <path d="M12 12.0111L12.01 12" {...LINE} />
      <path d="M3 12.0111L3.01 12" {...LINE} />
      <path d="M12 9.01111L12.01 9" {...LINE} />
      <path d="M12 15.0111L12.01 15" {...LINE} />
      <path d="M15 21.0111L15.01 21" {...LINE} />
      <path d="M12 21.0111L12.01 21" {...LINE} />
      <path d="M21 12.0111L21.01 12" {...LINE} />
      <path d="M21 15.0111L21.01 15" {...LINE} />
      <path d="M18 6.01111L18.01 6" {...LINE} />
      <path
        d="M9 3.6V8.4C9 8.73137 8.73137 9 8.4 9H3.6C3.26863 9 3 8.73137 3 8.4V3.6C3 3.26863 3.26863 3 3.6 3H8.4C8.73137 3 9 3.26863 9 3.6Z"
        {...LINE}
      />
      <path
        d="M21 3.6V8.4C21 8.73137 20.7314 9 20.4 9H15.6C15.2686 9 15 8.73137 15 8.4V3.6C15 3.26863 15.2686 3 15.6 3H20.4C20.7314 3 21 3.26863 21 3.6Z"
        {...LINE}
      />
      <path d="M6 18.0111L6.01 18" {...LINE} />
      <path
        d="M9 15.6V20.4C9 20.7314 8.73137 21 8.4 21H3.6C3.26863 21 3 20.7314 3 20.4V15.6C3 15.2686 3.26863 15 3.6 15H8.4C8.73137 15 9 15.2686 9 15.6Z"
        {...LINE}
      />
    </IconoirIcon>
  );
}

export function QuoteMessage(props: IconoirIconProps) {
  return (
    <IconoirIcon name="quote-message" {...props}>
      <path
        d="M3 20.2895V5C3 3.89543 3.89543 3 5 3H19C20.1046 3 21 3.89543 21 5V15C21 16.1046 20.1046 17 19 17H7.96125C7.35368 17 6.77906 17.2762 6.39951 17.7506L4.06852 20.6643C3.71421 21.1072 3 20.8567 3 20.2895Z"
        stroke="currentColor"
      />
      <path d="M10.5 10H8.5C7.94772 10 7.5 9.55228 7.5 9V8C7.5 7.44772 7.94772 7 8.5 7H9.5C10.0523 7 10.5 7.44772 10.5 8V10ZM10.5 10C10.5 11 9.5 12 8.5 13" {...ROUND_ENDS} />
      <path d="M16.5 10H14.5C13.9477 10 13.5 9.55228 13.5 9V8C13.5 7.44772 13.9477 7 14.5 7H15.5C16.0523 7 16.5 7.44772 16.5 8V10ZM16.5 10C16.5 11 15.5 12 14.5 13" {...ROUND_ENDS} />
    </IconoirIcon>
  );
}

export function RefreshDouble(props: IconoirIconProps) {
  return (
    <IconoirIcon name="refresh-double" {...props}>
      <path d="M21.1679 8C19.6247 4.46819 16.1006 2 11.9999 2C6.81459 2 2.55104 5.94668 2.04932 11" {...LINE} />
      <path d="M17 8H21.4C21.7314 8 22 7.73137 22 7.4V3" {...LINE} />
      <path d="M2.88146 16C4.42458 19.5318 7.94874 22 12.0494 22C17.2347 22 21.4983 18.0533 22 13" {...LINE} />
      <path d="M7.04932 16H2.64932C2.31795 16 2.04932 16.2686 2.04932 16.6V21" {...LINE} />
    </IconoirIcon>
  );
}

export function Search(props: IconoirIconProps) {
  return (
    <IconoirIcon name="search" {...props}>
      <path d="M17 17L21 21" {...LINE} />
      <path
        d="M3 11C3 15.4183 6.58172 19 11 19C13.213 19 15.2161 18.1015 16.6644 16.6493C18.1077 15.2022 19 13.2053 19 11C19 6.58172 15.4183 3 11 3C6.58172 3 3 6.58172 3 11Z"
        {...LINE}
      />
    </IconoirIcon>
  );
}

export function Settings(props: IconoirIconProps) {
  return (
    <IconoirIcon name="settings" {...props}>
      <path d="M12 15C13.6569 15 15 13.6569 15 12C15 10.3431 13.6569 9 12 9C10.3431 9 9 10.3431 9 12C9 13.6569 10.3431 15 12 15Z" {...LINE} />
      <path
        d="M19.6224 10.3954L18.5247 7.7448L20 6L18 4L16.2647 5.48295L13.5578 4.36974L12.9353 2H10.981L10.3491 4.40113L7.70441 5.51596L6 4L4 6L5.45337 7.78885L4.3725 10.4463L2 11V13L4.40111 13.6555L5.51575 16.2997L4 18L6 20L7.79116 18.5403L10.397 19.6123L11 22H13L13.6045 19.6132L16.2551 18.5155C16.6969 18.8313 18 20 18 20L20 18L18.5159 16.2494L19.6139 13.598L21.9999 12.9772L22 11L19.6224 10.3954Z"
        {...LINE}
      />
    </IconoirIcon>
  );
}

export function ShareAndroid(props: IconoirIconProps) {
  return (
    <IconoirIcon name="share-android" {...props}>
      <path d="M18 22C19.6569 22 21 20.6569 21 19C21 17.3431 19.6569 16 18 16C16.3431 16 15 17.3431 15 19C15 20.6569 16.3431 22 18 22Z" {...LINE} />
      <path d="M18 8C19.6569 8 21 6.65685 21 5C21 3.34315 19.6569 2 18 2C16.3431 2 15 3.34315 15 5C15 6.65685 16.3431 8 18 8Z" {...LINE} />
      <path d="M6 15C7.65685 15 9 13.6569 9 12C9 10.3431 7.65685 9 6 9C4.34315 9 3 10.3431 3 12C3 13.6569 4.34315 15 6 15Z" {...LINE} />
      <path d="M15.5 6.5L8.5 10.5" {...OUTLINE} />
      <path d="M8.5 13.5L15.5 17.5" {...OUTLINE} />
    </IconoirIcon>
  );
}

export function ShareIos(props: IconoirIconProps) {
  return (
    <IconoirIcon name="share-ios" {...props}>
      <path d="M20 13V19C20 20.1046 19.1046 21 18 21H6C4.89543 21 4 20.1046 4 19V13" {...LINE} />
      <path d="M12 15V3M12 3L8.5 6.5M12 3L15.5 6.5" {...LINE} />
    </IconoirIcon>
  );
}

export function SmartphoneDevice(props: IconoirIconProps) {
  return (
    <IconoirIcon name="smartphone-device" {...props}>
      <path d="M12 16.01L12.01 15.9989" {...LINE} />
      <path
        d="M7 19.4V4.6C7 4.26863 7.26863 4 7.6 4H16.4C16.7314 4 17 4.26863 17 4.6V19.4C17 19.7314 16.7314 20 16.4 20H7.6C7.26863 20 7 19.7314 7 19.4Z"
        {...OUTLINE}
      />
    </IconoirIcon>
  );
}

export function Sort(props: IconoirIconProps) {
  return (
    <IconoirIcon name="sort" {...props}>
      <path d="M10 14H2" {...LINE} />
      <path d="M8 10H2" {...LINE} />
      <path d="M6 6H2" {...LINE} />
      <path d="M12 18H2" {...LINE} />
      <path d="M19 20V4M19 20L22 17M19 20L16 17M19 4L22 7M19 4L16 7" {...LINE} />
    </IconoirIcon>
  );
}

export function Sparks(props: IconoirIconProps) {
  return (
    <IconoirIcon name="sparks" {...props}>
      <path
        d="M8 15C12.8747 15 15 12.949 15 8C15 12.949 17.1104 15 22 15C17.1104 15 15 17.1104 15 22C15 17.1104 12.8747 15 8 15Z"
        stroke="currentColor"
        strokeLinejoin="round"
      />
      <path
        d="M2 6.5C5.13376 6.5 6.5 5.18153 6.5 2C6.5 5.18153 7.85669 6.5 11 6.5C7.85669 6.5 6.5 7.85669 6.5 11C6.5 7.85669 5.13376 6.5 2 6.5Z"
        stroke="currentColor"
        strokeLinejoin="round"
      />
    </IconoirIcon>
  );
}

export function Star(props: IconoirIconProps) {
  return (
    <IconoirIcon name="star" {...props}>
      <path
        d="M8.58737 8.23597L11.1849 3.00376C11.5183 2.33208 12.4817 2.33208 12.8151 3.00376L15.4126 8.23597L21.2215 9.08017C21.9668 9.18848 22.2638 10.0994 21.7243 10.6219L17.5217 14.6918L18.5135 20.4414C18.6409 21.1798 17.8614 21.7428 17.1945 21.3941L12 18.678L6.80547 21.3941C6.1386 21.7428 5.35909 21.1798 5.48645 20.4414L6.47825 14.6918L2.27575 10.6219C1.73617 10.0994 2.03322 9.18848 2.77852 9.08017L8.58737 8.23597Z"
        {...LINE}
      />
    </IconoirIcon>
  );
}

export function StarSolid(props: IconoirIconProps) {
  return (
    <IconoirIcon name="star-solid" strokeWidth={undefined} {...props}>
      <path
        d="M8.58737 8.23597L11.1849 3.00376C11.5183 2.33208 12.4817 2.33208 12.8151 3.00376L15.4126 8.23597L21.2215 9.08017C21.9668 9.18848 22.2638 10.0994 21.7243 10.6219L17.5217 14.6918L18.5135 20.4414C18.6409 21.1798 17.8614 21.7428 17.1945 21.3941L12 18.678L6.80547 21.3941C6.1386 21.7428 5.35909 21.1798 5.48645 20.4414L6.47825 14.6918L2.27575 10.6219C1.73617 10.0994 2.03322 9.18848 2.77852 9.08017L8.58737 8.23597Z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </IconoirIcon>
  );
}

export function SunLight(props: IconoirIconProps) {
  return (
    <IconoirIcon name="sun-light" {...props}>
      <path d="M12 18C15.3137 18 18 15.3137 18 12C18 8.68629 15.3137 6 12 6C8.68629 6 6 8.68629 6 12C6 15.3137 8.68629 18 12 18Z" {...LINE} />
      <path d="M22 12L23 12" {...LINE} />
      <path d="M12 2V1" {...LINE} />
      <path d="M12 23V22" {...LINE} />
      <path d="M20 20L19 19" {...LINE} />
      <path d="M20 4L19 5" {...LINE} />
      <path d="M4 20L5 19" {...LINE} />
      <path d="M4 4L5 5" {...LINE} />
      <path d="M1 12L2 12" {...LINE} />
    </IconoirIcon>
  );
}

export function SwitchOff(props: IconoirIconProps) {
  return (
    <IconoirIcon name="switch-off" {...props}>
      <path d="M7 13C7.55228 13 8 12.5523 8 12C8 11.4477 7.55228 11 7 11C6.44772 11 6 11.4477 6 12C6 12.5523 6.44772 13 7 13Z" {...DOT} />
      <path d="M17 17H7C4.23858 17 2 14.7614 2 12C2 9.23858 4.23858 7 7 7H17C19.7614 7 22 9.23858 22 12C22 14.7614 19.7614 17 17 17Z" {...OUTLINE} />
    </IconoirIcon>
  );
}

export function TextSquare(props: IconoirIconProps) {
  return (
    <IconoirIcon name="text-square" {...props}>
      <path
        d="M21 3.6V20.4C21 20.7314 20.7314 21 20.4 21H3.6C3.26863 21 3 20.7314 3 20.4V3.6C3 3.26863 3.26863 3 3.6 3H20.4C20.7314 3 21 3.26863 21 3.6Z"
        {...LINE}
      />
      <path d="M7 9V7L17 7V9" {...LINE} />
      <path d="M12 7V17M12 17H10M12 17H14" {...LINE} />
    </IconoirIcon>
  );
}

export function Translate(props: IconoirIconProps) {
  return (
    <IconoirIcon name="translate" {...props}>
      <path
        d="M2 5H9M16 5H13.5M9 5L13.5 5M9 5V3M13.5 5C12.6795 7.73513 10.9612 10.3206 9 12.5929M4 17.5C5.58541 16.1411 7.376 14.4744 9 12.5929M9 12.5929C8 11.5 6.4 9.3 6 8.5M9 12.5929L12 15.5"
        {...LINE}
      />
      <path d="M13.5 21L14.6429 18M21.5 21L20.3571 18M14.6429 18L17.5 10.5L20.3571 18M14.6429 18H20.3571" {...LINE} />
    </IconoirIcon>
  );
}

export function Trash(props: IconoirIconProps) {
  return (
    <IconoirIcon name="trash" {...props}>
      <path d="M20 9L18.005 20.3463C17.8369 21.3026 17.0062 22 16.0353 22H7.96474C6.99379 22 6.1631 21.3026 5.99496 20.3463L4 9" {...LINE} />
      <path
        d="M21 6L15.375 6M3 6L8.625 6M8.625 6V4C8.625 2.89543 9.52043 2 10.625 2H13.375C14.4796 2 15.375 2.89543 15.375 4V6M8.625 6L15.375 6"
        {...LINE}
      />
    </IconoirIcon>
  );
}

export function User(props: IconoirIconProps) {
  return (
    <IconoirIcon name="user" {...props}>
      <path d="M5 20V19C5 15.134 8.13401 12 12 12V12C15.866 12 19 15.134 19 19V20" {...LINE} />
      <path d="M12 12C14.2091 12 16 10.2091 16 8C16 5.79086 14.2091 4 12 4C9.79086 4 8 5.79086 8 8C8 10.2091 9.79086 12 12 12Z" {...LINE} />
    </IconoirIcon>
  );
}

export function UserPlus(props: IconoirIconProps) {
  return (
    <IconoirIcon name="user-plus" {...props}>
      <path d="M17 10H20M23 10H20M20 10V7M20 10V13" {...LINE} />
      <path d="M1 20V19C1 15.134 4.13401 12 8 12V12C11.866 12 15 15.134 15 19V20" {...LINE} />
      <path d="M8 12C10.2091 12 12 10.2091 12 8C12 5.79086 10.2091 4 8 4C5.79086 4 4 5.79086 4 8C4 10.2091 5.79086 12 8 12Z" {...LINE} />
    </IconoirIcon>
  );
}

export function VideoCamera(props: IconoirIconProps) {
  return (
    <IconoirIcon name="video-camera" {...props}>
      <path
        d="M15 12V16.4C15 16.7314 14.7314 17 14.4 17H3.6C3.26863 17 3 16.7314 3 16.4V7.6C3 7.26863 3.26863 7 3.6 7H14.4C14.7314 7 15 7.26863 15 7.6V12ZM15 12L20.0159 7.82009C20.4067 7.49443 21 7.77232 21 8.28103V15.719C21 16.2277 20.4067 16.5056 20.0159 16.1799L15 12Z"
        {...LINE}
      />
    </IconoirIcon>
  );
}

export function VideoCameraOff(props: IconoirIconProps) {
  return (
    <IconoirIcon name="video-camera-off" {...props}>
      <path
        d="M6.5 7H3.6C3.26863 7 3 7.26863 3 7.6V16.4C3 16.7314 3.26863 17 3.6 17H14.4C14.7314 17 15 16.7314 15 16.4V15M11.5 7H14.4C14.7314 7 15 7.26863 15 7.6V10.719C15 11.2277 15.5933 11.5056 15.9841 11.1799L20.0159 7.82009C20.4067 7.49443 21 7.77232 21 8.28103V15.5"
        {...LINE}
      />
      <path d="M3 3L21 21" {...LINE} />
    </IconoirIcon>
  );
}

export function WarningTriangle(props: IconoirIconProps) {
  return (
    <IconoirIcon name="warning-triangle" {...props}>
      <path
        d="M20.0429 21H3.95705C2.41902 21 1.45658 19.3364 2.22324 18.0031L10.2662 4.01533C11.0352 2.67792 12.9648 2.67791 13.7338 4.01532L21.7768 18.0031C22.5434 19.3364 21.581 21 20.0429 21Z"
        {...ROUND_ENDS}
      />
      <path d="M12 9V13" {...ROUND_ENDS} />
      <path d="M12 17.01L12.01 16.9989" {...LINE} />
    </IconoirIcon>
  );
}

export function Xmark(props: IconoirIconProps) {
  return (
    <IconoirIcon name="xmark" {...props}>
      <path d="M6.75827 17.2426L12.0009 12M17.2435 6.75736L12.0009 12M12.0009 12L6.75827 6.75736M12.0009 12L17.2435 17.2426" {...LINE} />
    </IconoirIcon>
  );
}

export function XmarkCircle(props: IconoirIconProps) {
  return (
    <IconoirIcon name="xmark-circle" {...props}>
      <path d="M9.17218 14.8284L12.0006 12M14.829 9.17157L12.0006 12M12.0006 12L9.17218 9.17157M12.0006 12L14.829 14.8284" {...LINE} />
      <path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z" {...LINE} />
    </IconoirIcon>
  );
}
