sap.ui.define([], function () {
    "use strict";

    /**
     * Event handlers for the custom "Appointment Slot" section
     * (AppointmentSlots.fragment.xml). The slot data is prepared by
     * StickerControllerExtension and exposed through the "apptslots" JSON model:
     *   {
     *     dates:        ["2026-07-18", ...],           // sorted, distinct
     *     slotsByDate:  { "2026-07-18": [ {SlotId, FromTime, ToTime, label}, ... ] },
     *     minDate:      Date, maxDate: Date,           // range for the DatePicker
     *     currentSlots: [ ... ]                         // slots for the selected date
     *   }
     */
    return {

        /**
         * Fired when the user picks an appointment date. Refreshes the time-slot
         * dropdown to the slots for that date and clears any previous slot pick,
         * or flags an error if the date has no slots.
         */
        onAppointmentDateChange: function (oEvent) {
            var oDatePicker = oEvent.getSource();
            var bValid = oEvent.getParameter("valid");
            var oContext = oDatePicker.getBindingContext();
            var oSlotModel = oDatePicker.getModel("apptslots");
            if (!oContext || !oSlotModel) {
                return;
            }

            // AppointmentDate has already been written to the context by two-way binding.
            var sDate = oContext.getProperty("AppointmentDate"); // "yyyy-MM-dd"
            var mByDate = oSlotModel.getProperty("/slotsByDate") || {};
            var aSlots = (sDate && mByDate[sDate]) || [];

            oSlotModel.setProperty("/currentSlots", aSlots);

            // Reset the previously chosen slot whenever the date changes.
            oContext.setProperty("SlotId", "");
            oContext.setProperty("AppointmentFromTime", null);
            oContext.setProperty("AppointmentToTime", null);

            if (!bValid || (sDate && aSlots.length === 0)) {
                oDatePicker.setValueState("Error");
                oDatePicker.setValueStateText("Please select an available appointment date.");
            } else {
                oDatePicker.setValueState("None");
                oDatePicker.setValueStateText("");
            }
        },

        /**
         * Fired when the user picks a time slot. Writes the slot's times and id
         * back to the Sticker Master entity.
         */
        onAppointmentSlotChange: function (oEvent) {
            var oComboBox = oEvent.getSource();
            var oItem = oEvent.getParameter("selectedItem");
            var oContext = oComboBox.getBindingContext();
            var oSlotModel = oComboBox.getModel("apptslots");
            if (!oContext || !oSlotModel) {
                return;
            }

            if (!oItem) {
                oContext.setProperty("SlotId", "");
                oContext.setProperty("AppointmentFromTime", null);
                oContext.setProperty("AppointmentToTime", null);
                return;
            }

            var sSlotId = oItem.getKey();
            var aSlots = oSlotModel.getProperty("/currentSlots") || [];
            var oSlot = aSlots.filter(function (s) {
                return s.SlotId === sSlotId;
            })[0];
            if (!oSlot) {
                return;
            }

            oContext.setProperty("SlotId", oSlot.SlotId);
            oContext.setProperty("AppointmentFromTime", oSlot.FromTime);
            oContext.setProperty("AppointmentToTime", oSlot.ToTime);
        }
    };
});
