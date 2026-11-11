const f = new Intl.DateTimeFormat("id-ID", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" });
export const fmtWib = (d: Date) => `${f.format(d)} WIB`;
