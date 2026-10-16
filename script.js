
const refreshButton = document.getElementById("refresh-btn");
const systemMessage = document.getElementById("system-message");


refreshButton.addEventListener("click", function () {
    totalAircraft = totalAircraft + 1;
    aircraftCount.textContent = totalAircraft;
    systemMessage.textContent = "Aircraft count updated.";
});



const aircraftCount = document.getElementById("aircraft-count");

let totalAircraft = 128;

aircraftCount.textContent = totalAircraft;



const aircraftList = [
    {
        flight: "AI 101",
        type: "Boeing 737",
        altitude: 35000,
        speed: 420
    },
    {
        flight: "UK 820",
        type: "Airbus A320",
        altitude: 28000,
        speed: 390
    },
    {
        flight: "6E 234",
        type: "Airbus A321",
        altitude: 32000,
        speed: 410
    }
];

console.log(aircraftList);


console.log(aircraft);

console.log(aircraft.flight);
