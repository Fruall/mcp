import countries from "i18n-iso-countries";
import fs from "node:fs";
const py = fs.readFileSync(process.argv[2], "utf8");
const re = /"([A-Z]{2})": \{"1": (\d+), "Region": "([^"]+)"\}/g;
let m, n = 0, mism = [];
while ((m = re.exec(py))) {
  n++;
  const num = countries.alpha2ToNumeric(m[1]);
  const expected = num ? 2000 + Number(num) : null;
  if (expected !== Number(m[2])) mism.push([m[1], m[2], num, m[3]]);
}
console.log("python entries:", n, "mismatches:", mism.length);
console.log(mism);
console.log("iso count:", Object.keys(countries.getAlpha2Codes()).length);
