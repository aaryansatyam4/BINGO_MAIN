"use client";

import { usePathname } from "next/navigation";
import { NavLink } from "./ui";

const ITEMS = [
  { href: "/", label: "Home", sub: "Ask · approvals · progress" },
  { href: "/studio", label: "Studio", sub: "Creatives & brand" },
  { href: "/build", label: "Build", sub: "Websites & deploys" },
  { href: "/global", label: "Global", sub: "Distributors & meetings" },
  { href: "/speak", label: "Speak", sub: "Calls & escalation" },
  { href: "/skills", label: "Skills", sub: "Learned workflows" },
  { href: "/activity", label: "Activity", sub: "History & jobs" },
  { href: "/settings", label: "Settings", sub: "AI models & connections" },
];

export function Nav() {
  const path = usePathname();
  return (
    <nav className="nav" aria-label="Main">
      {ITEMS.map((i) => (
        <NavLink key={i.href} {...i} active={i.href === "/" ? path === "/" || path.startsWith("/workflows") : path.startsWith(i.href)} />
      ))}
    </nav>
  );
}
