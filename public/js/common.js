// DOM helpers shared by host and player pages. All user text goes through text nodes — never innerHTML.
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style" && typeof v === "object") {
        for (const [sk, sv] of Object.entries(v)) {
          if (sv === null || sv === undefined) continue;
          if (sk.startsWith("--")) el.style.setProperty(sk, String(sv));
          else el.style[sk] = sv;
        }
      }
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "html") el.innerHTML = v; // only for server-generated markup (QR svg)
      else if (k === "dataset") Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

export function badge(p, opts = {}) {
  if (!p) return h("span", { class: "badge" }, "?");
  return h("span", { class: `badge ${p.connected === false ? "offline" : ""} ${opts.class || ""}`, style: { "--bc": p.color || "#888" } },
    h("span", { class: "ava" }, h("span", null, p.emoji || "")),
    opts.noName ? null : h("span", { class: "name" }, p.name),
    opts.vip && p.isVip ? h("span", { class: "vip" }, "VIP") : null,
  );
}

export function fmtPoints(n) {
  const sign = n < 0 ? "-" : "+";
  return `${sign}${Math.abs(n).toLocaleString()}`;
}

export function fmtScore(n) { return Number(n || 0).toLocaleString(); }

// Server/client clock sync: remaining seconds for a deadline.
export function makeClock() {
  let offset = 0;
  return {
    sync(serverNow) { if (typeof serverNow === "number") offset = serverNow - Date.now(); },
    now() { return Date.now() + offset; },
    remaining(endsAt) { return endsAt ? Math.max(0, endsAt - this.now()) : 0; },
  };
}

export function fitHeadline(text) {
  // Split the prompt around the blank so the blank can be styled.
  const i = text.indexOf("___");
  if (i === -1) return [text];
  return [text.slice(0, i), h("span", { class: "blank" }, "______"), text.slice(i + 3)];
}

export function placeLabel(n) {
  if (n === 1) return "1st";
  if (n === 2) return "2nd";
  if (n === 3) return "3rd";
  return `${n}th`;
}

export function ordinalWord(n) {
  return ["", "FIRST", "SECOND", "THIRD", "FOURTH", "FIFTH", "SIXTH", "SEVENTH", "EIGHTH", "NINTH", "TENTH"][n] || `${n}TH`;
}
