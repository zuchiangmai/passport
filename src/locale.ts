export type Language = "en" | "zh" | "th";

export function passportLanguage(value: string | null | undefined): Language | undefined {
  const primary = value?.trim().toLowerCase().split("-")[0];
  if (primary === "en" || primary === "zh" || primary === "th") return primary;
}

export function preferredLanguage(acceptLanguage: string | null | undefined): Language {
  const choices = (acceptLanguage ?? "").split(",").map((entry) => {
    const [value, weight] = entry.trim().split(";");
    return { language: passportLanguage(value), weight: weight ? Number(weight.trim().slice(2)) : 1 };
  }).sort((a, b) => b.weight - a.weight);
  return choices.find(({ language, weight }) => language && weight > 0)?.language ?? "en";
}
