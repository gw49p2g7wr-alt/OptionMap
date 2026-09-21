(function (root, factory) {
    const common = typeof module === "object" && module.exports && !(root && root.document);
    const contract = common ? require("./sourceContract.js") : root?.OptionMapJpxDerivativesOpenInterestSourceContract;
    const api = factory(contract);
    if (common) module.exports = api;
    if (root) root.OptionMapJpxDerivativesOpenInterestWorkbookParser = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (contract) {
    "use strict";
    const HEADERS = Object.freeze(["限月取引", "取引高", "当日\n建玉残高", "前日比", "前日\n建玉残高"]);
    const SIDE = Object.freeze({ "プット": "put", "コール": "call", "合計": "total" });
    const valueFields = Object.freeze(["tradingVolume", "currentOpenInterest",
        "changeFromPreviousDay", "previousOpenInterest"]);
    const cell = (sheet, address) => sheet[address] || null;
    const address = (XLSX, row, column) => XLSX.utils.encode_cell({ r: row - 1, c: column });
    const display = value => String(value?.w ?? value?.v ?? "").trim();
    function diagnostic(code, detail = {}) { return { severity: "blocking", code, ...detail }; }
    function excelDate(value) {
        if (!Number.isFinite(value)) return null;
        const epoch = Date.UTC(1899, 11, 30) + Math.round(value) * 86400000;
        return new Date(epoch).toISOString().slice(0, 10);
    }
    function filenameDate(url) {
        try { const match = new URL(url).pathname.match(/\/(20\d{6})open_interest\.xlsx$/);
            return match ? `${match[1].slice(0, 4)}-${match[1].slice(4, 6)}-${match[1].slice(6)}` : null;
        } catch (_error) { return null; }
    }
    function sourceCell(sheetName, addressValue, source) {
        return { sheetName, cellAddress: addressValue, cellType: source?.t ?? null,
            underlyingValue: source?.v ?? null, formattedValue: display(source),
            numberFormat: source?.z ?? null };
    }
    function valueState(source, { delta = false, sheetName, addressValue }, diagnostics) {
        const provenance = sourceCell(sheetName, addressValue, source);
        if (!source || source.v === undefined || source.v === null || source.v === "") {
            return { semantic: { state: "blank", sourceLexeme: "" }, provenance };
        }
        if (source.v === "-") return { semantic: { state: "not_applicable", sourceLexeme: "-" }, provenance };
        if (source.t !== "n" || !Number.isSafeInteger(source.v) || source.f) {
            diagnostics.push(diagnostic("numeric_cell_invalid", { cellAddress: addressValue }));
            return { semantic: { state: "invalid", sourceLexeme: display(source) }, provenance };
        }
        const formatted = display(source).replace(/,/g, "").replace(/\s/g, "");
        if (delta) {
            if (source.z !== contract.SIGNED_NUMBER_FORMAT) diagnostics.push(diagnostic(
                "signed_number_format_invalid", { cellAddress: addressValue, numberFormat: source.z ?? null }));
            const expected = source.v === 0 ? "±0" : source.v > 0 ? `+${source.v}` : String(source.v);
            if (formatted !== expected) diagnostics.push(diagnostic("signed_display_mismatch",
                { cellAddress: addressValue, expected, actual: formatted }));
        } else {
            if (!contract.INTEGER_NUMBER_FORMATS.includes(source.z)) diagnostics.push(diagnostic(
                "integer_number_format_invalid", { cellAddress: addressValue, numberFormat: source.z ?? null }));
            if (formatted !== String(source.v)) diagnostics.push(diagnostic("integer_display_mismatch",
                { cellAddress: addressValue, expected: String(source.v), actual: formatted }));
        }
        return { semantic: { state: "value", value: source.v }, provenance };
    }
    function parseValues(XLSX, sheet, row, columns, diagnostics, sheetName) {
        const semantic = {}, provenance = [];
        columns.forEach((column, index) => { const addressValue = address(XLSX, row, column), parsed =
            valueState(cell(sheet, addressValue), { delta: index === 2, sheetName, addressValue }, diagnostics);
            semantic[valueFields[index]] = parsed.semantic; provenance.push({ field: valueFields[index], ...parsed.provenance }); });
        const states = valueFields.map(field => semantic[field].state);
        const allValues = states.every(state => state === "value"), allNA = states.every(state => state === "not_applicable");
        if (!allValues && !allNA) diagnostics.push(diagnostic("mixed_numeric_states", { row }));
        if (allValues && semantic.currentOpenInterest.value !== semantic.previousOpenInterest.value +
            semantic.changeFromPreviousDay.value) diagnostics.push(diagnostic("open_interest_arithmetic_mismatch", { row }));
        return { semantic, provenance, allValues, allNA };
    }
    function productId(label) { return contract.normalizeText(label).replace(/[^\p{L}\p{N}]+/gu, "_")
        .replace(/^_+|_+$/g, "").toLowerCase(); }
    function contractMonth(value) { const match = String(value || "").match(/^(20\d{2})年(0[1-9]|1[0-2])月限$/);
        return match ? `${match[1]}-${match[2]}` : null; }
    function recordKey(parts) { return parts.join("|"); }
    function validateHeader(XLSX, sheet, row, start, diagnostics) {
        HEADERS.forEach((expected, offset) => { const actual = cell(sheet, address(XLSX, row, start + offset));
            if (contract.normalizeText(actual?.v) !== contract.normalizeText(expected)) diagnostics.push(diagnostic(
                "header_mismatch", { cellAddress: address(XLSX, row, start + offset), expected, actual: actual?.v ?? null })); });
    }
    function validateOptionsHeader(XLSX, sheet, row, diagnostics) {
        const expected = ["取引高", "当日\n建玉残高", "前日比", "前日\n建玉残高"];
        if (contract.normalizeText(cell(sheet, address(XLSX, row, 1))?.v)) diagnostics.push(
            diagnostic("option_side_header_mismatch", { cellAddress: address(XLSX, row, 1) }));
        expected.forEach((value, offset) => { const at = address(XLSX, row, offset + 2), actual = cell(sheet, at)?.v;
            if (contract.normalizeText(actual) !== contract.normalizeText(value)) diagnostics.push(
                diagnostic("header_mismatch", { cellAddress: at, expected: value, actual: actual ?? null })); });
    }
    function parseFutures(XLSX, sheet, startRow, endRow, sheetName, diagnostics) {
        const records = [], provenance = [], seen = new Set();
        for (const group of [{ product: 0, contract: 1, values: [2, 3, 4, 5], id: "left" },
            { product: 7, contract: 8, values: [9, 10, 11, 12], id: "right" }]) {
            let product = null, productHasTotal = false;
            for (let row = startRow + 2; row < endRow; row += 1) {
                const contractCell = cell(sheet, address(XLSX, row, group.contract));
                if (contract.normalizeText(contractCell?.v) === "限月取引") {
                    if (product && !productHasTotal) diagnostics.push(diagnostic("futures_total_missing", { product, group: group.id }));
                    validateHeader(XLSX, sheet, row, group.contract, diagnostics); product = null; productHasTotal = false; continue;
                }
                const productCell = cell(sheet, address(XLSX, row, group.product));
                if (contract.normalizeText(productCell?.v)) {
                    if (product && !productHasTotal) diagnostics.push(diagnostic("futures_total_missing", { product, group: group.id }));
                    product = contract.normalizeText(productCell.v); productHasTotal = false;
                }
                const label = contract.normalizeText(contractCell?.v);
                if (!label) continue;
                if (!product) { diagnostics.push(diagnostic("product_inheritance_missing", { row, group: group.id })); continue; }
                const rowKind = label === "合計" ? "official_total" : label === "-" ? "not_applicable" : "contract";
                const month = rowKind === "contract" ? contractMonth(label) : null;
                if (rowKind === "contract" && !month) diagnostics.push(diagnostic("contract_month_invalid", { row, value: label }));
                const parsed = parseValues(XLSX, sheet, row, group.values, diagnostics, sheetName);
                if (rowKind === "not_applicable" && !parsed.allNA) diagnostics.push(diagnostic("not_applicable_row_invalid", { row }));
                if (rowKind !== "not_applicable" && !parsed.allValues) diagnostics.push(diagnostic("required_numeric_missing", { row }));
                const identity = { block: "ose_index_futures", productId: productId(product), rowKind,
                    contractMonth: month };
                const key = recordKey(Object.values(identity));
                if (seen.has(key)) diagnostics.push(diagnostic("duplicate_identity", { key })); seen.add(key);
                records.push({ recordIdentity: identity, product: { officialLabel: product,
                    canonicalId: identity.productId }, rowKind, contractMonth: month, ...parsed.semantic });
                if (rowKind === "official_total") productHasTotal = true;
                provenance.push({ recordIdentity: identity, group: group.id, row, cells: parsed.provenance });
            }
            if (product && !productHasTotal) diagnostics.push(diagnostic("futures_total_missing", { product, group: group.id }));
        }
        return { records, provenance };
    }
    function parseOptions(XLSX, sheet, startRow, endRow, sheetName, diagnostics) {
        const records = [], provenance = [], seen = new Set(); let product = null, sequence = [];
        for (let row = startRow + 2; row < endRow; row += 1) {
            const productCell = cell(sheet, address(XLSX, row, 0));
            if (contract.normalizeText(productCell?.v)) { if (sequence.length && sequence.join(",") !== "put,call,total")
                diagnostics.push(diagnostic("option_structure_invalid", { row: row - sequence.length, sequence }));
                product = contract.normalizeText(productCell.v); sequence = []; }
            const sideLabel = contract.normalizeText(cell(sheet, address(XLSX, row, 1))?.v);
            if (!sideLabel) continue;
            const side = SIDE[sideLabel];
            if (!side || !product) { diagnostics.push(diagnostic("option_side_invalid", { row, value: sideLabel })); continue; }
            sequence.push(side);
            const parsed = parseValues(XLSX, sheet, row, [2, 3, 4, 5], diagnostics, sheetName);
            if (!parsed.allValues) diagnostics.push(diagnostic("required_numeric_missing", { row }));
            const identity = { block: "ose_index_options", productId: productId(product),
                rowKind: side === "total" ? "official_total" : "side", side };
            const key = recordKey(Object.values(identity)); if (seen.has(key)) diagnostics.push(diagnostic("duplicate_identity", { key })); seen.add(key);
            records.push({ recordIdentity: identity, product: { officialLabel: product,
                canonicalId: identity.productId }, rowKind: identity.rowKind, side, ...parsed.semantic });
            provenance.push({ recordIdentity: identity, row, cells: parsed.provenance });
        }
        if (sequence.length && sequence.join(",") !== "put,call,total") diagnostics.push(diagnostic(
            "option_structure_invalid", { row: endRow - sequence.length, sequence }));
        return { records, provenance };
    }
    function locateUnique(sheet, anchor, XLSX) { const matches = [];
        const range = XLSX.utils.decode_range(sheet["!ref"] || "A1:A1");
        for (let row = range.s.r; row <= range.e.r; row += 1) for (let column = range.s.c; column <= range.e.c; column += 1) {
            const value = cell(sheet, XLSX.utils.encode_cell({ r: row, c: column }));
            if (value?.v === anchor) matches.push({ row: row + 1, column }); }
        return matches;
    }
    function totalDiagnostics(block, records) {
        const results = [], products = [...new Set(records.map(item => item.product.canonicalId))];
        for (const productIdValue of products) {
            const set = records.filter(item => item.product.canonicalId === productIdValue), total =
                set.find(item => item.rowKind === "official_total"), components = set.filter(item =>
                    item.rowKind === (block === "ose_index_futures" ? "contract" : "side"));
            if (!total || components.length === 0) continue;
            for (const field of valueFields) {
                if (total[field]?.state !== "value" || components.some(item => item[field]?.state !== "value")) continue;
                const sum = components.reduce((value, item) => value + item[field].value, 0);
                results.push({ severity: "informational", code: sum === total[field].value ?
                    "official_total_matches_components" : "official_total_differs_from_components",
                block, productId: productIdValue, field, officialValue: total[field].value, componentSum: sum });
            }
        }
        return results;
    }
    function parse({ XLSX, bytes, listingDate, workbookUrl, listingUrl, fetchedAt,
        httpMetadata = {}, workbookSha256 }) {
        const diagnostics = [];
        const byteView = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
        if (byteView.byteLength === 0 || byteView.byteLength > 10 * 1024 * 1024) diagnostics.push(
            diagnostic("workbook_size_invalid", { byteLength: byteView.byteLength }));
        const zipInventory = typeof Buffer !== "undefined" ? Buffer.from(byteView).toString("latin1") :
            String.fromCharCode(...byteView.slice(0, 1000000));
        if (/vbaProject\.bin|xl\/externalLinks\/|EncryptedPackage/i.test(zipInventory)) diagnostics.push(
            diagnostic("unsafe_workbook_relationship"));
        if (diagnostics.length) return { accepted: false, diagnostics };
        let workbook; try { workbook = XLSX.read(bytes, { type: "array", cellStyles: true,
            cellNF: true, cellText: true, bookVBA: true }); } catch (error) { return { accepted: false,
                diagnostics: [diagnostic("workbook_parse_failed", { message: error.message })] }; }
        if (workbook.vbaraw) diagnostics.push(diagnostic("workbook_macro_forbidden"));
        const requiredSheets = [contract.SHEET_NAME, "別紙1", "別紙2"];
        if (workbook.SheetNames.length !== requiredSheets.length ||
            requiredSheets.some((name, index) => workbook.SheetNames[index] !== name)) diagnostics.push(
            diagnostic("workbook_sheet_inventory_invalid", { sheetNames: workbook.SheetNames }));
        if (workbook.SheetNames.filter(name => name === contract.SHEET_NAME).length !== 1) diagnostics.push(
            diagnostic("sheet_missing_or_duplicate"));
        const sheet = workbook.Sheets[contract.SHEET_NAME]; if (!sheet) return { accepted: false, diagnostics };
        if ((sheet["!ref"] || "") !== "A1:HZ513") diagnostics.push(diagnostic("sheet_range_invalid", { range: sheet["!ref"] }));
        const title = contract.normalizeText(cell(sheet, "A1")?.v);
        if (title !== "JPXデリバティブ建玉残高状況(概算)") diagnostics.push(diagnostic("title_invalid", { title }));
        const sheetDate = excelDate(cell(sheet, "A2")?.v), urlDate = filenameDate(workbookUrl);
        if (!contract.isDate(listingDate) || listingDate !== urlDate || listingDate !== sheetDate)
            diagnostics.push(diagnostic("source_date_mismatch", { listingDate, filenameDate: urlDate, sheetDate }));
        const futures = locateUnique(sheet, contract.FUTURES_ANCHOR, XLSX), options =
            locateUnique(sheet, contract.OPTIONS_ANCHOR, XLSX);
        if (futures.length !== 1 || futures[0]?.column !== 0) diagnostics.push(diagnostic("futures_anchor_invalid", { matches: futures }));
        if (options.length !== 1 || options[0]?.column !== 0) diagnostics.push(diagnostic("options_anchor_invalid", { matches: options }));
        if (diagnostics.length) return { accepted: false, diagnostics };
        validateHeader(XLSX, sheet, futures[0].row + 1, 1, diagnostics);
        validateHeader(XLSX, sheet, futures[0].row + 1, 8, diagnostics);
        validateOptionsHeader(XLSX, sheet, options[0].row + 1, diagnostics);
        const nextFutures = locateUnique(sheet, "＜OSE 商品先物取引＞", XLSX);
        const nextOptions = locateUnique(sheet, "＜権利行使数量（オプション）＞", XLSX);
        if (nextFutures.length !== 1 || nextOptions.length !== 1) diagnostics.push(diagnostic("section_boundary_invalid"));
        if (diagnostics.length) return { accepted: false, diagnostics };
        const parsedFutures = parseFutures(XLSX, sheet, futures[0].row, nextFutures[0].row,
            contract.SHEET_NAME, diagnostics);
        const parsedOptions = parseOptions(XLSX, sheet, options[0].row, nextOptions[0].row,
            contract.SHEET_NAME, diagnostics);
        const notes = [357, 358, 360].map(row => ({ noteId: `sheet-row-${row}`,
            officialText: contract.normalizeText(cell(sheet, `A${row}`)?.v), sourceCell: `A${row}` }))
            .filter(note => note.officialText);
        const canonical = { schemaVersion: contract.SCHEMA_VERSION, sourceId: contract.SOURCE_ID,
            sourceDate: listingDate, preliminary: true, revisionExpected: true,
            blocks: { oseIndexFutures: { records: parsedFutures.records },
                oseIndexOptions: { records: parsedOptions.records } }, officialNotes: notes };
        const evidence = { sourceId: contract.SOURCE_ID, acquiredAt: fetchedAt, listingUrl,
            workbookUrl, workbookSha256, httpMetadata: contract.clone(httpMetadata), parserVersion: contract.PARSER_VERSION,
            sourceDateEvidence: { listingDate, filenameDate: urlDate, sheetDate, consistent: true },
            workbookMetadata: { sheetNames: [...workbook.SheetNames], selectedSheet: contract.SHEET_NAME },
            anchors: { futures: `A${futures[0].row}`, options: `A${options[0].row}` },
            headers: { futures: [`B${futures[0].row + 1}:F${futures[0].row + 1}`,
                `I${futures[0].row + 1}:M${futures[0].row + 1}`],
                options: `B${options[0].row + 1}:F${options[0].row + 1}` },
            recordProvenance: [...parsedFutures.provenance, ...parsedOptions.provenance], warnings: [] };
        return { accepted: diagnostics.length === 0, canonical: diagnostics.length ? null : canonical,
            evidence: diagnostics.length ? null : evidence, diagnostics,
            informational: [...totalDiagnostics("ose_index_futures", parsedFutures.records),
                ...totalDiagnostics("ose_index_options", parsedOptions.records)], counts: {
                futures: parsedFutures.records.length, options: parsedOptions.records.length,
                total: parsedFutures.records.length + parsedOptions.records.length } };
    }
    return Object.freeze({ parse, excelDate, filenameDate, valueState });
});
