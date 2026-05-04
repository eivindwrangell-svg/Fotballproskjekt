const express = require("express");

const app = express();
const PORT = 3000;

// CORS: gjør at frontend på 5500 kan kalle proxy på 3000
app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    next();
});

// Logger alle requests (bra for debugging)
app.use((req, res, next) => {
    console.log("REQ:", req.method, req.url);
    next();
});

function normalizeNordic(str) {
    return str
        .replace(/ø/g, "o").replace(/Ø/g, "O")
        .replace(/æ/g, "ae").replace(/Æ/g, "Ae")
        .replace(/å/g, "a").replace(/Å/g, "A");
}

function commonsFileToUrl(filename) {
    const encoded = encodeURIComponent(filename.replace(/ /g, "_"));
    return `https://commons.wikimedia.org/wiki/Special:FilePath/${encoded}?width=200`;
}

// Søker i Wikidata (wbsearchentities) og returnerer liste av "hits"
async function searchWikidata(term, lang) {
    const url =
        "https://www.wikidata.org/w/api.php" +
        "?action=wbsearchentities" +
        "&search=" + encodeURIComponent(term) +
        "&language=" + encodeURIComponent(lang) +
        "&uselang=" + encodeURIComponent(lang) +
        "&type=item" +
        "&format=json" +
        "&limit=50" +
        "&origin=*";

    const r = await fetch(url, {
        headers: { "User-Agent": "FotballLagbygger/1.0 (local dev)" }
    });

    if (!r.ok) return [];

    const data = await r.json();
    return data.search || [];
}

// Henter detaljer for id-er (wbgetentities): bilde (P18) + occupation (P106)
async function fetchDetailsForIds(ids) {
    if (!ids.length) return {};

    const url =
        "https://www.wikidata.org/w/api.php" +
        "?action=wbgetentities" +
        "&ids=" + encodeURIComponent(ids.join("|")) +
        "&props=claims" +
        "&format=json" +
        "&origin=*";

    const r = await fetch(url, {
        headers: { "User-Agent": "FotballLagbygger/1.0 (local dev)" }
    });

    if (!r.ok) return {};

    const data = await r.json();
    const entities = data.entities || {};

    const map = {};

    for (const id of ids) {
        const ent = entities[id];
        const claims = ent?.claims;

        // P18 = image
        const p18 = claims?.P18?.[0]?.mainsnak?.datavalue?.value;
        const imgUrl = p18 ? commonsFileToUrl(p18) : "";

        // P106 = occupation -> vil ha "association football player" = Q937857
        const occupations = claims?.P106 || [];
        const isFootballer = occupations.some((occ) => {
            const occId = occ?.mainsnak?.datavalue?.value?.id;
            return occId === "Q937857";
        });

        map[id] = { img: imgUrl, isFootballer };
    }

    return map;
}

app.get("/api/search", async (req, res) => {
    const qRaw = String(req.query.q || "").trim();
    console.log("Incoming search:", qRaw);

    if (!qRaw) return res.json([]);

    try {
        const term1 = qRaw;
        const term2 = normalizeNordic(qRaw);

        // 1) Prøv engelsk med original tekst
        let hits = await searchWikidata(term1, "en");

        // 2) Hvis ingen treff, prøv "oede..."-variant (ø→o, etc.)
        if (!hits.length && term2 !== term1) {
            hits = await searchWikidata(term2, "en");
        }

        // 3) Hvis fortsatt ingen treff, prøv norsk
        if (!hits.length) {
            hits = await searchWikidata(term1, "nb");
            if (!hits.length && term2 !== term1) {
                hits = await searchWikidata(term2, "nb");
            }
        }

        // Map til {id, name}
        const results = hits.map((item) => ({
            id: item.id,
            name: item.label || "Ukjent",
        }));

        // Hent detaljer for flere id-er (for filtrering)
        const ids = results.slice(0, 30).map(r => r.id).filter(Boolean);
        const detailsMap = await fetchDetailsForIds(ids);

        // Filtrer til fotballspillere + bygg final {name, img}
        const finalResults = results
            .filter(r => detailsMap[r.id]?.isFootballer)
            .map(r => ({
                name: r.name,
                img: detailsMap[r.id]?.img || ""
            }))
            .slice(0, 20); // begrens hva vi sender tilbake til UI

        console.log("Final results:", finalResults.length);
        return res.json(finalResults);

    } catch (e) {
        console.log("SERVER ERROR:", e);
        return res.status(500).json([]);
    }
});

app.listen(PORT, () => {
    console.log(`Proxy running on http://localhost:${PORT}`);
});
