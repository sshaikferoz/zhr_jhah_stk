sap.ui.define([], function () {
    "use strict";

    // "HH:MM:SS" (Edm.TimeOfDay) -> "H:MM AM/PM" for slot labels only.
    // The raw value is kept for saving.
    function formatTime12h(sTime) {
        if (!sTime) {
            return "";
        }
        var aParts = String(sTime).split(":");
        var iHour = parseInt(aParts[0], 10);
        var sMin = aParts[1] || "00";
        if (isNaN(iHour)) {
            return String(sTime);
        }
        var sMeridiem = iHour >= 12 ? "PM" : "AM";
        var iHour12 = iHour % 12;
        if (iHour12 === 0) {
            iHour12 = 12;
        }
        return iHour12 + ":" + sMin + " " + sMeridiem;
    }

    return {
        formatTime12h: formatTime12h,

        // "HH:MM:SS" pair -> "H:MM AM - H:MM PM". Empty when no slot is
        // chosen: a cleared slot is stored as 00:00:00/00:00:00.
        range: function (sFrom, sTo) {
            var bCleared =
                String(sFrom).indexOf("00:00") === 0 &&
                String(sTo).indexOf("00:00") === 0;
            if (!sFrom || !sTo || bCleared) {
                return "";
            }
            return formatTime12h(sFrom) + " - " + formatTime12h(sTo);
        }
    };
});
