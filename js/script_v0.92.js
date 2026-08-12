console.log("script.js 読み込み成功！");

let myChart = null;

let optionMap = {};
window.setWeeklyOptionMap = function (result) {
    optionMap = result?.optionMap || {};

    console.log(
        "週次オプションを価格帯マップへ反映:",
        optionMap
    );

    drawOptionTable();
};

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

        const text = optionData.value;
        
        const totals = analyzeData(text);

        const ranking = Object.entries(totals);
        ranking.sort((a, b) => b[1] - a[1]);
        const top10 = ranking.slice(0, 10);

        const labels = [];
        const values = [];

        for (const item of top10) {

        labels.push(companyNames[item[0]] || item[0]);
        values.push(item[1]);

}
        


        drawChart(labels, values);

        drawOptionTable();
        
        showMaxPosition();

    },1000);

});

function analyzeData(text) {

    const lines = text.split("\n");

    console.log("analyzeData開始");

    const totals = {};

    let currentPrice = "";

    for (const line of lines) {

        console.log(JSON.stringify(line));

        const priceMatch = line.match(/(\d{2},\d{3})\s*円/);

        if (priceMatch) {
        
            currentPrice = priceMatch[1].replace(",", "");
        
            console.log("価格帯:", currentPrice);
        
        
        }  
        
        if (!line.includes("証券")) continue;

        const words = line.trim().split(/\s+/);

        const company = words.find(word => word.includes("証券"));

        const volumeText = words[words.length - 1];
        const volume = Number(volumeText.replace(/,/g, ""));

        console.log(words);
        console.log(company);
        console.log(volumeText);
        console.log(volume);

        if (!company || isNaN(volume)) continue;

        if (!totals[company]) {
            totals[company] = 0;
        }

        totals[company] += volume;
        if (!optionMap[currentPrice]) {
            optionMap[currentPrice] = {};
        }
        
        if (!optionMap[currentPrice][company]) {
            optionMap[currentPrice][company] = 0;
        }
        
        optionMap[currentPrice][company] += volume;

    }
    console.log(optionMap);
    return totals;

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
                label: "取引枚数",
                data: values
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

function showMaxPosition() {
    
    console.log("showMaxPosition optionMap =", optionMap);
    
    let maxPrice = "";
    let maxCompany = "";
    let maxValue = 0;

    for (const price in optionMap) {

        for (const company in optionMap[price]) {

            const value = optionMap[price][company];

            if (value > maxValue) {

                maxValue = value;
                maxPrice = price;
                maxCompany = company;

            }

        }

    }

    const result = document.getElementById("maxPosition");


    result.innerHTML = `
    <p><strong>価格帯</strong></p>
    <h2>${Number(maxPrice).toLocaleString()}円</h2>

    <p><strong>証券会社</strong></p>
    <h3>${companyNames[maxCompany] || maxCompany}</h3>

    <p><strong>建玉</strong></p>
    <h2>${maxValue.toLocaleString()}枚</h2>
`;    

}

function showPriceRanking() {

    const ranking = [];    
    
    for (const price in optionMap) {

    }

}