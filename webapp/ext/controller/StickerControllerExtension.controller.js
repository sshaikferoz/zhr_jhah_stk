sap.ui.define([
    "sap/ui/core/mvc/ControllerExtension",
    "sap/ui/core/Fragment",
    "sap/ui/model/json/JSONModel",
    "com/jhah/zhrjhahsecstk/ext/util/SlotTimeFormat"
], function (ControllerExtension, Fragment, JSONModel, SlotTimeFormat) {
    "use strict";

    var formatTime12h = SlotTimeFormat.formatTime12h;

    // FromTime/ToTime (and HideApp) are computed on the backend from the chosen
    // slot. Writing via Context#setProperty bypasses the FE field wiring, so the
    // metadata side effects never fire — request them explicitly so the computed
    // fields refresh. Queued in the same $auto batch as the patches.
    function requestAppointmentSideEffects(oContext) {
        oContext.requestSideEffects([
            "FromTime", "ToTime", "HideApp", "AppointmentFromTime", "AppointmentToTime"
        ]).catch(function (err) {
            console.error("Failed to refresh appointment side effects:", err);
        });
    }

    return ControllerExtension.extend("com.jhah.zhrjhahsecstk.ext.controller.StickerControllerExtension", {

        override: {
            onInit: function () {
                var oView = this.base.getView();

                try {
                    // Safe model initialization
                    var oViolatorModel = new JSONModel({ isVisible: false });
                    oView.setModel(oViolatorModel, "violator");

                    // Style hook used by css/style.css to scope the strip
                    oView.addStyleClass("zhrjhahsecstk-app");
                    document.body.classList.add("zhrjhahsecstk-app");

                    // Hide the Create/Copy/Edit/Delete actions by default; they
                    // are revealed only once the auth check confirms the user
                    // is NOT a Sticker admin (admins get a read-only view).
                    this._applyMaintenanceActionVisibility();
                } catch (err) {
                    console.error("Error in StickerControllerExtension onInit:", err);
                }
            },

            routing: {
                onAfterBinding: function (oBindingContext) {
                    var oView = this.base.getView();
                    var oAppModel = oView.getModel();

                    if (!oAppModel) return;

                    var oViolatorModel = oView.getModel("violator");
                    if (!oViolatorModel) {
                        oViolatorModel = new JSONModel({ isVisible: false });
                        oView.setModel(oViolatorModel, "violator");
                    }

                    // Only act on the Sticker Master object page context
                    if (oBindingContext && oBindingContext.getPath().indexOf("/StickerMaster") !== -1) {

                        // Build the appointment-slot picker data used by the
                        // AppointmentDatePicker / TimeSlotSelect custom fields.
                        this._loadAppointmentSlots(oView, oAppModel, oBindingContext);

                        oBindingContext.requestProperty("JhahId").then(function (sJhahId) {

                            if (sJhahId && sJhahId.trim() !== "") {
                                var sPath = "/EmployeeDetails('" + sJhahId + "')";

                                var oContext = oAppModel.bindContext(sPath, null, {
                                    "$$groupId": "$direct"
                                });

                                oContext.requestObject().then(function (oData) {
                                    if (oData && oViolatorModel) {
                                        oViolatorModel.setData(Object.assign({}, oData, { isVisible: true }));
                                    }
                                }).catch(function (err) {
                                    console.error("Failed to fetch employee details:", err);
                                    if (oViolatorModel) oViolatorModel.setData({ isVisible: false });
                                });
                            } else {
                                if (oViolatorModel) oViolatorModel.setData({ isVisible: false });
                            }
                        }).catch(function (err) {
                            console.error("Failed to read JhahId property:", err);
                            if (oViolatorModel) oViolatorModel.setData({ isVisible: false });
                        });
                    }
                }
            }
        },

        /**
         * Fetch every appointment slot and expose it through the "apptslots" JSON
         * model used by the custom Appointment Slot section. Groups slots by date,
         * derives the DatePicker min/max range, and seeds the time-chip grid with
         * the slots for the currently selected date.
         */
        _loadAppointmentSlots: function (oView, oAppModel, oBindingContext) {
            var oSlotModel = oView.getModel("apptslots");
            if (!oSlotModel) {
                oSlotModel = new JSONModel({
                    dates: [], slotsByDate: {}, minDate: null, maxDate: null, currentSlots: []
                });
                oView.setModel(oSlotModel, "apptslots");
            }

            var oSlotBinding = oAppModel.bindList("/AppointmentSlot", null, null, null, { $$groupId: "$direct" });
            Promise.all([
                oSlotBinding.requestContexts(0, 1000),
                oBindingContext.requestProperty("AppointmentDate"),
                oBindingContext.requestProperty("AppointmentFromTime"),
                oBindingContext.requestProperty("SlotId"),
                oBindingContext.requestProperty("AppointmentToTime")
            ]).then(function (aResult) {
                var aContexts = aResult[0] || [];
                var sCurrentDate = aResult[1];
                var sCurrentTime = aResult[2];
                var sCurrentSlotId = aResult[3];
                var sCurrentToTime = aResult[4];



                var mByDate = {};
                var aDates = [];
                var mSeen = {};
                aContexts.forEach(function (oCtx) {
                    var oSlot = oCtx.getObject();
                    var sDate = oSlot.AppointmentDate;
                    if (!sDate) { return; }
                    // The entity key also spans Apps/StickerRequest, so the
                    // backend can return the same physical interval as several
                    // rows; keep only the first row per slot.
                    var sSeenKey = sDate + "#" + oSlot.SlotId + "#" + oSlot.FromTime;
                    if (mSeen[sSeenKey]) { return; }
                    mSeen[sSeenKey] = true;
                    if (!mByDate[sDate]) {
                        mByDate[sDate] = [];
                        aDates.push(sDate);
                    }
                    // A slot with exhausted capacity stays visible but its chip
                    // is disabled. Capacity 0 means "not maintained", not full.
                    var bFull = oSlot.Capacity > 0 && oSlot.Booked >= oSlot.Capacity;
                    var sRange = formatTime12h(oSlot.FromTime) + " - " + formatTime12h(oSlot.ToTime);
                    mByDate[sDate].push({
                        // SlotId is only unique per DATE in the backend (e.g.
                        // "SLOT:20260718" for every interval of that day), so a
                        // synthetic key including FromTime disambiguates the items.
                        key: oSlot.SlotId + "#" + oSlot.FromTime,
                        SlotId: oSlot.SlotId,
                        FromTime: oSlot.FromTime,
                        ToTime: oSlot.ToTime,
                        full: bFull,
                        // The chips and the value-help input both show the
                        // from-to range; label adds the booked hint for tooltips.
                        rangeLabel: sRange,
                        label: sRange + (bFull ? " (fully booked)" : "")
                    });
                });
                aDates.sort();
                // Chronological chips regardless of backend row order
                // ("HH:MM:SS" sorts lexicographically).
                Object.keys(mByDate).forEach(function (sKey) {
                    mByDate[sKey].sort(function (a, b) {
                        return a.FromTime < b.FromTime ? -1 : (a.FromTime > b.FromTime ? 1 : 0);
                    });
                });

                oSlotModel.setData({
                    dates: aDates,
                    slotsByDate: mByDate,
                    minDate: aDates.length ? new Date(aDates[0] + "T00:00:00") : null,
                    maxDate: aDates.length ? new Date(aDates[aDates.length - 1] + "T00:00:00") : null,
                    currentSlots: (sCurrentDate && mByDate[sCurrentDate]) || []
                });
                oSlotModel.setProperty(
                    "/selectedKey",
                    sCurrentSlotId + "#" + sCurrentTime
                );
                // Value shown in the value-help input; empty until a slot is chosen.
                oSlotModel.setProperty(
                    "/selectedLabel",
                    sCurrentSlotId
                        ? formatTime12h(sCurrentTime) + " - " + formatTime12h(sCurrentToTime)
                        : ""
                );

            }).catch(function (err) {
                console.error("Failed to load appointment slots:", err);
            });
        },

        /**
         * Fired when the user picks an appointment date (invoked from
         * AppointmentDatePicker.fragment.xml via the .extension handler syntax).
         * Refreshes the time-chip grid to the slots for that date and clears
         * any previous slot pick, or flags an error if the date has no slots.
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

            // Reset the previously chosen slot whenever the date changes; the
            // chip highlight follows /selectedKey and the input text follows
            // /selectedLabel, so clearing them resets the whole picker.
            oSlotModel.setProperty("/selectedKey", "");
            oSlotModel.setProperty("/selectedLabel", "");
            oContext.setProperty("SlotId", "");
            oContext.setProperty("AppointmentFromTime", "00:00:00");
            oContext.setProperty("AppointmentToTime", "00:00:00");
            requestAppointmentSideEffects(oContext);

            if (!bValid || (sDate && aSlots.length === 0)) {
                oDatePicker.setValueState("Error");
                oDatePicker.setValueStateText("Please select an available appointment date.");
            } else {
                oDatePicker.setValueState("None");
                oDatePicker.setValueStateText("");
            }
        },

        /**
         * Fired when the user clicks the time-slot value-help input (invoked
         * from TimeSlotSelect.fragment.xml via the .extension handler syntax).
         * Lazily loads the TimeSlotPopover fragment and opens it by the input.
         */
        onAppointmentSlotValueHelp: function (oEvent) {
            var oInput = oEvent.getSource();
            var oView = this.base.getView();

            if (!this._pSlotPopover) {
                this._pSlotPopover = Fragment.load({
                    id: oView.getId() + "--slotPopover",
                    name: "com.jhah.zhrjhahsecstk.ext.fragment.TimeSlotPopover",
                    controller: this
                }).then(function (oPopover) {
                    // Dependent of the view so the apptslots model and the
                    // StickerMaster binding context propagate into the popover.
                    oView.addDependent(oPopover);
                    return oPopover;
                });
            }
            this._pSlotPopover.then(function (oPopover) {
                oPopover.openBy(oInput);
            });
        },

        onAppointmentSlotPopoverCancel: function () {
            if (this._pSlotPopover) {
                this._pSlotPopover.then(function (oPopover) {
                    oPopover.close();
                });
            }
        },

        /**
         * Fired when the user presses a time-slot chip in the popover grid
         * (TimeSlotPopover.fragment.xml). Highlights the chip via /selectedKey,
         * writes the slot's times and id back to the Sticker Master entity and
         * closes the popover.
         */
        onAppointmentSlotPress: function (oEvent) {
            var oButton = oEvent.getSource();
            var oView = this.base.getView();
            var oContext = oButton.getBindingContext() || oView.getBindingContext();
            var oSlotModel = oView.getModel("apptslots");
            if (!oContext || !oSlotModel) {
                return;
            }

            // Read the slot straight off the pressed chip's binding context.
            // A key lookup would be ambiguous: the backend reuses one SlotId for
            // every interval of a day (e.g. "SLOT:20260718"), so matching on
            // SlotId alone always resolves to that date's first slot.
            var oItemContext = oButton.getBindingContext("apptslots");
            var oSlot = oItemContext && oItemContext.getObject();
            if (!oSlot) {
                return;
            }

            oSlotModel.setProperty("/selectedKey", oSlot.key);
            oSlotModel.setProperty("/selectedLabel", oSlot.rangeLabel);
            oContext.setProperty("SlotId", oSlot.SlotId);
            oContext.setProperty("AppointmentFromTime", oSlot.FromTime);
            oContext.setProperty("AppointmentToTime", oSlot.ToTime);
            requestAppointmentSideEffects(oContext);

            this.onAppointmentSlotPopoverCancel();
        },

        /**
         * Toggle visibility of the role-gated actions based on the logged-in
         * user's Sticker-admin flag. The flag lives on the VAR service's
         * EmployeeHeader entity (StickerAdmin = "X" for admins), exposed here
         * via the "varAuth" model. Two independent, opposite gates are applied:
         *
         *   1. Maintenance actions (Create, Edit, Delete): hidden FROM admins —
         *      admins get a read-only view (body.hideMaintenanceActions +
         *      css/style.css), shown to everyone else.
         *   2. Admin-only actions ("Copy Request" / CopySticker and "Maintain
         *      Appointment Locations" / SemanticObject MaintAppointmentLocation):
         *      shown ONLY to admins (body.hideAdminOnlyActions + css/style.css),
         *      hidden for everyone else.
         *
         * Both are set to their safe default (hidden) until the check resolves,
         * so nothing flashes in; on a failed check they stay at that default.
         */
        _applyMaintenanceActionVisibility: function () {
            // Safe defaults until the role is known: maintenance actions hidden
            // (revealed for non-admins) and the admin-only actions hidden
            // (revealed only for admins).
            document.body.classList.add("hideMaintenanceActions");
            document.body.classList.add("hideAdminOnlyActions");

            // During onInit the view isn't connected to the component tree yet,
            // so named component models aren't propagated to it. Read the model
            // from the app component, which owns it, and fall back to the view.
            var oView = this.base.getView();
            var oComponent = (typeof this.base.getAppComponent === "function") ? this.base.getAppComponent() : null;
            var oVarModel = (oComponent && oComponent.getModel("varAuth")) || (oView && oView.getModel("varAuth"));
            if (!oVarModel) {
                console.error("varAuth model not available for Sticker admin check.");
                return;
            }

            try {
                var oListBinding = oVarModel.bindList("/EmployeeHeader", null, null, null, { $$groupId: "$direct" });
                oListBinding.requestContexts(0, 1).then(function (aContexts) {
                    var bIsStickerAdmin = false;
                    if (aContexts && aContexts.length > 0) {
                        var oUserData = aContexts[0].getObject();
                        bIsStickerAdmin = oUserData && oUserData.StickerAdmin === "X";
                    }
                    if (bIsStickerAdmin) {
                        // Admins: read-only (Create/Edit/Delete hidden), but keep
                        // the admin-only actions (Copy Request, Maintain Locations).
                        document.body.classList.add("hideMaintenanceActions");
                        document.body.classList.remove("hideAdminOnlyActions");
                    } else {
                        // Non-admins: full maintenance, but no admin-only actions.
                        document.body.classList.remove("hideMaintenanceActions");
                        document.body.classList.add("hideAdminOnlyActions");
                    }
                }).catch(function (err) {
                    console.error("Sticker admin check fetch failed:", err);
                    // Keep both at their safe default (hidden) on failure.
                });
            } catch (err) {
                console.error("Error running Sticker admin check:", err);
            }
        }
    });
});
