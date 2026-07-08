console.log("script.js 読み込み成功！");

let myChart = null;

let priceChart = null;

let optionMap = {};

let priceTotals = {};

const companyNames = {
    "ＡＢＮクリアリン証券": "ABN",
    "ソシエテＧ証券": "SG",
    "バークレイズ証券": "Barclays",
    "ＳＢＩ証券": "SBI",
    "楽天証券": "Rakuten",
    "ＪＰモルガン証券": "JPM",
    "ゴールドマン証券": "Goldman",
    "ビーオブエー証券": "BofA",
    "日産証券": "Nissan",
    "フィリップ証券": "Phillip",
    "松井証券": "Matsui",
    "みずほ証券": "Mizuho",
    "野村証券": "Nomura",
    "モルガンＭＵＦＧ証券": "MorganMUFG",
    "マネックス証券": "Monex",
    "インタラクティブ証券": "IB",
    "ＵＢＳ証券": "UBS",
    "シティグループ証券": "Citi",
    "ＨＳＢＣ証券": "HSBC",
    "ドイツ証券": "Deutsche",
    "ＢＮＰパリバ証券": "BNP",
    "三菱ＵＦＪ証券": "MUFG",
    "光世証券": "Kosei",
    "ＳＭＢＣ日興証券": "SMBC"
};

const button = document.getElementById("analyzeButton");
const nightData = document.getElementById("nightData");
const optionData = document.getElementById("optionData");

button.addEventListener("click", function () {

    optionMap = {};

    setTimeout(function () {

        const nightText = nightData.value;
        const dayText = dayData.value;
        const optionText = optionData.value;

        const nightTotals = analyzeFutureData(nightText);
        const dayTotals = analyzeFutureData(dayText);
        const optionTotals = analyzeOptionData(optionText);

        
        const allTotals = {};

        for (const price in nightTotals) {
            allTotals[price] = nightTotals[price];
        }

        for (const price in dayTotals) {

            if (allTotals[price] === undefined) {
                allTotals[price] = 0;
            }

            allTotals[price] += dayTotals[price];

        }

        for (const price in optionTotals) {

            if (allTotals[price] === undefined) {
                allTotals[price] = 0;
            }

            allTotals[price] += optionTotals[price];

        }

        const ranking = Object.entries(allTotals);
        ranking.sort((a, b) => b[1] - a[1]);
        const top10 = ranking.slice(0, 10);

        const labels = [];
        const values = [];

        for (const item of top10) {

            labels.push(companyNames[item[0]] || item[0]);
            values.push(item[1]);

        }

        drawChart(labels, values);

    const priceRanking = Object.entries(optionTotals);
          priceRanking.sort((a, b) => b[1] - a[1]);

    const priceLabels = [];
    const priceValues = [];

for (const item of priceRanking) {
    priceLabels.push(Number(item[0]).toLocaleString() + "円");
    priceValues.push(item[1]);
}

drawPriceChart(priceLabels, priceValues);

drawOptionTable();

showMaxPosition(optionTotals);

showPriceRanking();

    }, 1000);

});

function analyzeFutureData(text) {

    const lines = text.split("\n");

    console.log("analyzeData開始");


    const totals = {};
    

    for (const line of lines) {

        const words = line.trim().split(/\s+/);

     if (words.length < 8) continue;

        const company = words.find(word => word.includes("証券"));

        const volume = Number(words[words.length - 1].replace(/,/g, ""));

        console.log(JSON.stringify(line));

       
        if (!line.includes("証券")) continue;

      
        console.log(words);
        console.log(company);
        console.log(volume);

        if (!company || isNaN(volume)) continue;

        if (!totals[company]) {
            totals[company] = 0;
        }

        totals[company] += volume;

    }
    console.log(totals);
    return totals;

}

function analyzeOptionData(text) {

    const lines = text.split("\n");

    console.log("analyzeData開始");

    const totals = {};
    const priceTotals = {};

    let currentPrice = "";

    for (const line of lines) {

        console.log(JSON.stringify(line));

        const priceMatch = line.match(/(\d{2},\d{3})\s*円/);

        if (priceMatch) {

            currentPrice = priceMatch[1].replace(",", "");

            console.log("価格帯:", currentPrice);


        }

        if (!line.includes("証券")) continue;

        if (currentPrice === "") {
            console.log("価格が空！", line);
        }

        const words = line.trim().split(/\s+/);

        const company = words.find(word => word.includes("証券"));

        const volumeText = words[words.length - 1];
        const volume = Number(volumeText.replace(/,/g, ""));

        console.log(words);
        console.log(company);
        console.log(volumeText);
        console.log(volume);

        if (!company || isNaN(volume)) continue;

        if (currentPrice === "") {
            console.log("価格が空！！", line);
        }

        if (!totals[company]) {
            totals[company] = 0;
        }

        totals[company] += volume;

        if (!priceTotals[currentPrice]) {
            priceTotals[currentPrice] = 0;
        }

        priceTotals[currentPrice] += volume;

        if (!optionMap[currentPrice]) {
            optionMap[currentPrice] = {};
        }

        if (!optionMap[currentPrice][company]) {
            optionMap[currentPrice][company] = 0;
        }

        optionMap[currentPrice][company] += volume;

    }
    console.log(optionMap);
    return priceTotals;

}

function drawChart(labels, values) {

    const ctx = document.getElementById("myChart");

    if (myChart) {
        myChart.destroy();
    }

    myChart = new Chart(ctx, {
        type: "bar",
        data: {
            labels: labels,
            datasets: [{
                label: "建玉枚数",
                data: values,
            
                backgroundColor: values.map(value => {
                    if (value >= 50000) return "#ff4d4d";   // 赤
                    if (value >= 30000)  return "#ff9933";   // オレンジ
                    if (value >= 10000)  return "#ffd966";   // 黄色
                    return "#b6d7a8";                      // 緑
                }),
            
                borderColor: "#2f6fb6",
                borderWidth: 1,
            
                barPercentage: 0.95,
                categoryPercentage: 0.85
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false
        }
    });

}

function drawPriceChart(labels, values) {

    const ctx = document.getElementById("priceChart");

    if (priceChart) {
        priceChart.destroy();
    }
    priceChart = new Chart(ctx, {
        type: "bar",
        data: {
            labels: labels,
            datasets: [{
                label: "価格帯建玉",
                data: values,

                backgroundColor: values.map(value => {

                    if (value >= 3000) return "#ff4d4d";   // 赤
                    if (value >= 500)  return "#ff9933";   // オレンジ
                    if (value >= 100)  return "#ffd966";   // 黄色

                    return "#b6d7a8";                      // 緑
                }),

                borderColor: "#2f6fb6",
                borderWidth: 1,

                barPercentage: 0.95,
                categoryPercentage: 0.85

            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false
        }
    });


}

function showOptionMap() {

    const result = document.getElementById("optionMapResult");

    result.innerHTML = "";

    const prices = Object.keys(optionMap).sort((a, b) => Number(a) - Number(b));

    for (const price of prices) {

        const title = document.createElement("h3");
        title.textContent = Number(price).toLocaleString() + " 円";
        result.appendChild(title);

        const ul = document.createElement("ul");

        const companies = optionMap[price];

        for (const company in companies) {

            const li = document.createElement("li");

            li.textContent =
                (companyNames[company] || company) +
                " : " +
                companies[company] +
                "枚";

            ul.appendChild(li);
        }

        result.appendChild(ul);

    }

}

function drawOptionTable() {

    const companies = [
        "ＢＮＰパリバ証券",
        "ＪＰモルガン証券",
        "ＡＢＮクリアリン証券",
        "ＵＢＳ証券",
        "バークレイズ証券",
        "ソシエテＧ証券",
        "ゴールドマン証券",
        "楽天証券",
        "松井証券",
        "モルガンＭＵＦＧ証券"
    ];

    const table = document.getElementById("optionMapTable");
    table.innerHTML = "";

    // ヘッダー
    const header = document.createElement("tr");

    const thPrice = document.createElement("th");
    thPrice.textContent = "価格";
    header.appendChild(thPrice);

    const thTotal = document.createElement("th");
    thTotal.textContent = "合計";
    header.appendChild(thTotal);

    for (const company of companies) {

        const th = document.createElement("th");
        th.textContent = companyNames[company];
        header.appendChild(th);

    }

    table.appendChild(header);

    // データ行
    const prices = Object.keys(optionMap).sort((a, b) => Number(a) - Number(b));

    for (const price of prices) {

        const tr = document.createElement("tr");

        // 価格
        const tdPrice = document.createElement("td");
        tdPrice.textContent = Number(price).toLocaleString() + "円";
        tdPrice.style.fontWeight = "bold";
        tdPrice.style.textAlign = "center";
        tr.appendChild(tdPrice);

        // 合計を計算
        let total = 0;

        for (const company of companies) {
            total += optionMap[price][company] || 0;
        }

        // 合計セル
        const tdTotal = document.createElement("td");
        tdTotal.textContent = total.toLocaleString();
        tdTotal.style.fontWeight = "bold";
        tdTotal.style.textAlign = "center";



        if (total >= 3000) {
            tdTotal.style.backgroundColor = "#ff4d4d";
        }
        else if (total >= 500) {
            tdTotal.style.backgroundColor = "#ff9933";
        }
        else if (total >= 100) {
            tdTotal.style.backgroundColor = "#ffd966";
        }
        else if (total >= 1) {
            tdTotal.style.backgroundColor = "#b6d7a8";
        }

        tr.appendChild(tdTotal);

        // 各会社
        for (const company of companies) {

            const td = document.createElement("td");

            const value = optionMap[price][company] || 0;

            td.textContent = value.toLocaleString();
            td.style.textAlign = "center";
            td.style.fontWeight = "bold";

            if (value >= 3000) {
                td.style.backgroundColor = "#ff4d4d";
            }
            else if (value >= 500) {
                td.style.backgroundColor = "#ff9933";
            }
            else if (value >= 100) {
                td.style.backgroundColor = "#ffd966";
            }
            else if (value >= 1) {
                td.style.backgroundColor = "#b6d7a8";
            }

            if (value === 0) {
                td.style.color = "#cccccc";
            }

            tr.appendChild(td);

        }

        table.appendChild(tr);

    }

}

function showMaxPosition(priceTotals) {

    let maxPrice = "";
    let maxValue = 0;

    for (const price in priceTotals) {

        const value = priceTotals[price];

        if (value > maxValue) {

            maxValue = value;
            maxPrice = price;

        }

    }



const result = document.getElementById("maxPosition");


result.innerHTML = `
    <p><strong>価格帯</strong></p>
    <h2>${Number(maxPrice).toLocaleString()}円</h2>

   
    <p><strong>建玉</strong></p>
    <h2>${maxValue.toLocaleString()}枚</h2>
`;    

}

function showPriceRanking() {

    const ranking = [];

    for (const price in optionMap) {

        let total = 0;

        for (const company in optionMap[price]) {
            total += optionMap[price][company];
        }

        ranking.push({
            price: price,
            total: total

        });

    }

    ranking.sort((a, b) => b.total - a.total);

    const result = document.getElementById("priceRanking");

    result.innerHTML = "";

    for (const item of ranking) {

        result.innerHTML += `
        <p>${Number(item.price).toLocaleString()}円 : ${item.total.toLocaleString()}枚</p>
        `;

    }
}