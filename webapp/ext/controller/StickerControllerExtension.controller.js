sap.ui.define([
    "sap/ui/core/mvc/ControllerExtension",
    "sap/ui/core/Fragment",
    "sap/ui/core/Element",
    "sap/ui/core/format/DateFormat",
    "sap/ui/base/Event",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageBox",
    "sap/m/Label",
    "sap/m/Text",
    "sap/ui/layout/form/FormElement",
    "com/jhah/zhrjhahsecstk/ext/util/SlotTimeFormat"
], function (ControllerExtension, Fragment, Element, DateFormat, Event, Filter, FilterOperator, JSONModel, MessageBox, Label, Text, FormElement, SlotTimeFormat) {
    "use strict";

    var formatTime12h = SlotTimeFormat.formatTime12h;

    var MS_PER_HOUR = 60 * 60 * 1000;
    var MS_PER_DAY = 24 * MS_PER_HOUR ;

    // Rescheduling and cancelling both close this many hours before the
    // appointment starts, and a sticker can only be renewed inside this many
    // days before it expires.
    var APPOINTMENT_CUTOFF_HOURS = 24;
    var RENEW_WINDOW_DAYS = 30;

    // A requester may hold at most this many stickers that are issued and not
    // yet expired; a further request is rejected before the draft is created.
    // "Issued" has no dedicated flag on StickerMaster — the status is expressed
    // through StatsCriticality, where 3 is the positive (issued) value.
    var MAX_ACTIVE_STICKERS = 2;
    var ISSUED_CRITICALITY = 3;

    // Marks a toolbar button whose press handler has already been wrapped, so
    // re-binding the page doesn't guard the same button twice.
    var GUARD_FLAG = "zhrActionGuarded";

    // Properties the guarded rules read. Neither the object page nor the list
    // report table necessarily has them in its $select — ExpireDate is
    // annotated as hidden, and the appointment fields are not columns — so the
    // guard loads them for the affected rows before it validates.
    var APPOINTMENT_PROPERTIES = ["AppointmentDate", "AppointmentFromTime"];
    // Reschedule additionally reads the security-reschedule flag, which lifts
    // the 24h cutoff for the employee (see _validateReschedule).
    var RESCHEDULE_PROPERTIES = APPOINTMENT_PROPERTIES.concat(["isSecurityRescheduled"]);
    // ExpireDate drives the renewal-window rule; ContractEnddate is shown
    // read-only in the Renew Sticker dialog, so both are preloaded here.
    var RENEW_PROPERTIES = ["ExpireDate", "ContractEnddate"];

    // Marks the read-only Contract End Date field injected into the Renew
    // Sticker action dialog, so a re-opened dialog is not given a second copy.
    var CONTRACT_END_FIELD_FLAG = "zhrContractEndField";

    var oDateFormat = DateFormat.getDateInstance({ style: "medium" });
    // Edm.Date literal for $filter. Formatted rather than derived from
    // toISOString(), which would shift the day for negative UTC offsets.
    var oEdmDateFormat = DateFormat.getDateInstance({ pattern: "yyyy-MM-dd", calendarType: "Gregorian" });

    function formatDate(oDate) {
        return oDate ? oDateFormat.format(oDate) : "";
    }

    // Edm.Date reaches the client as "yyyy-MM-dd" and Edm.TimeOfDay as
    // "HH:mm:ss"; both are wall-clock values, so they are read as local time.
    function toLocalDate(sDate, sTime) {
        if (!sDate) { return null; }
        var oDate = new Date(sDate + "T" + (sTime || "00:00:00"));
        return isNaN(oDate.getTime()) ? null : oDate;
    }

    // ABAP truth flags reach the client as an Edm.Boolean (true), but tolerate
    // the raw 'X'/'x' char form too in case the value arrives unconverted.
    function isTrueFlag(vValue) {
        return vValue === true || vValue === "X" || vValue === "x";
    }

    function startOfToday() {
        var oToday = new Date();
        oToday.setHours(0, 0, 0, 0);
        return oToday;
    }

    function addDays(oDate, iDays) {
        var oResult = new Date(oDate.getTime());
        oResult.setDate(oResult.getDate() + iDays);
        return oResult;
    }

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

                    // The annotation-driven toolbar buttons exist by the time the
                    // page is bound, so this is where they get their guards.
                    try {
                        this._applyActionGuards();
                    } catch (err) {
                        console.error("Failed to apply action guards:", err);
                    }

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
         * Count the requester's stickers that are issued (StatsCriticality = 3)
         * and not yet expired, i.e. the same set as
         *
         *   /StickerMaster/$count?$filter=ExpireDate gt <today>
         *                                 and StatsCriticality eq 3
         *
         * The service scopes StickerMaster to the logged-in user, so no
         * requester filter is added here.
         *
         * @returns {Promise<number>} the number of active stickers
         */
        _requestActiveStickerCount: function () {
            var oModel = this.base.getView().getModel();
            if (!oModel) {
                return Promise.reject(new Error("Main OData model not available."));
            }

            var aFilters = [
                new Filter("StatsCriticality", FilterOperator.EQ, ISSUED_CRITICALITY),
                new Filter("ExpireDate", FilterOperator.GT, oEdmDateFormat.format(startOfToday())),
                // StickerMaster is draft-enabled, so it also holds the draft
                // siblings of issued stickers — without this an issued sticker
                // that is currently being edited would be counted twice.
                new Filter("IsActiveEntity", FilterOperator.EQ, true)
            ];

            var oBinding = oModel.bindList("/StickerMaster", null, null, aFilters, {
            });

            // Sends $count=true&$top=0 — the count only, no entity payload.
            return oBinding.getHeaderContext().requestProperty("$count");
        },

        /**
         * Block the creation of a new request once the requester already holds
         * the maximum number of active stickers. Called from editFlow's
         * onBeforeCreate hook, which stops the Create when the returned promise
         * rejects — so the error is shown instead of the draft being created.
         *
         * If the count cannot be read the create is let through; the backend
         * still enforces the limit and a failed lookup should not lock the user
         * out of the app.
         */
        _checkActiveStickerLimit: function () {
            return this._requestActiveStickerCount().then(function (iCount) {
                if (iCount < MAX_ACTIVE_STICKERS) {
                    return;
                }

                MessageBox.error(
                    "You already have " + iCount + " active stickers. A maximum of " +
                    MAX_ACTIVE_STICKERS + " is allowed, so a new request can only be " +
                    "created once one of them expires."
                );

                // FE only inspects whether the promise rejects; the reason is
                // never surfaced, the MessageBox above is what the user sees.
                return Promise.reject(new Error("Active sticker limit reached."));
            }, function (err) {
                console.error("Failed to read the active sticker count:", err);
            });
        },

        /**
         * Wrap the press handler of the annotation-driven "Reschedule", "Renew
         * Sticker" and "Cancel Request" buttons so a business rule is checked
         * BEFORE Fiori Elements opens the action dialog or fires the action. On
         * a violation the FE handlers are never reached, so the user sees the
         * error instead of the popup.
         *
         * Idempotent: buttons already wrapped are skipped, and buttons that do
         * not carry a press handler yet are retried on the next binding.
         */
        _applyActionGuards: function () {
            this._guardActionButton("reschedulePopup", {
                properties: RESCHEDULE_PROPERTIES,
                validate: this._validateReschedule
            });
            this._guardActionButton("RenewSticker", {
                properties: RENEW_PROPERTIES,
                validate: this._validateRenew,
                // FE opens its action dialog once the button is replayed; add the
                // read-only Contract End Date field to it right afterwards.
                afterReplay: this._injectRenewContractEndDate
            });
            // Cancel Request runs straight away — FE opens no dialog of its own
            // for a parameterless action — and cannot be undone, so it is also
            // confirmed once it passes the same cutoff Reschedule uses.
            this._guardActionButton("CancelRequest", {
                properties: APPOINTMENT_PROPERTIES,
                validate: this._validateAppointmentChange,
                confirm: this._confirmCancel
            });
        },

        /**
         * @param {string} sActionName Fragment of the FE-generated button id —
         *        action buttons carry the unbound action name (see css/style.css,
         *        which gates the same buttons by id).
         * @param {object} mGuard
         * @param {string[]} mGuard.properties Properties the rule reads; loaded
         *        for every affected row before the rule runs.
         * @param {function} mGuard.validate Called with each context the action
         *        would run on; returns an error text to block the action, or
         *        null to allow it.
         * @param {function} [mGuard.confirm] Called with those contexts once the
         *        validation passed; returns the text of a Yes/No confirmation to
         *        put in front of the action, or null to run it straight away.
         * @param {function} [mGuard.afterReplay] Called with the first affected
         *        context immediately after the wrapped FE handler runs (i.e. once
         *        FE has been asked to open its action dialog). Used to enrich that
         *        dialog after FE has built it.
         */
        _guardActionButton: function (sActionName, mGuard) {
            var that = this;
            var oView = this.base.getView();

            var aButtons = oView.findAggregatedObjects(true, function (oControl) {
                return oControl.isA("sap.m.Button") &&
                    oControl.getId().indexOf(sActionName) !== -1;
            });

            aButtons.forEach(function (oButton) {
                if (oButton.data(GUARD_FLAG)) { return; }

                // FE attaches its own press handler when it builds the button;
                // detach it, put ours in front, and replay it only when the
                // validation passes. UI5 has no way to stop later handlers of
                // the same event, so wrapping is the only ordering that works.
                var aHandlers = ((oButton.mEventRegistry && oButton.mEventRegistry.press) || []).slice();
                if (!aHandlers.length) { return; }

                aHandlers.forEach(function (oHandler) {
                    oButton.detachPress(oHandler.fFunction, oHandler.oListener);
                });

                oButton.attachPress(function (oEvent) {
                    var aContexts = that._resolveActionContexts(oButton);

                    // The press event belongs to UI5 and may be recycled once
                    // this handler returns, while the checks below hand control
                    // back to the event loop first — so the replay gets its own
                    // copy carrying the same id, source and parameters.
                    var oReplayEvent = new Event(
                        oEvent.getId(), oEvent.getSource(), Object.assign({}, oEvent.getParameters())
                    );
                    var fnReplay = function () {
                        aHandlers.forEach(function (oHandler) {
                            oHandler.fFunction.call(oHandler.oListener || oButton, oReplayEvent, oHandler.oData);
                        });
                        if (mGuard.afterReplay) {
                            mGuard.afterReplay.call(that, aContexts[0]);
                        }
                    };

                    that._requestGuardProperties(aContexts, mGuard.properties).then(function () {
                        var sError = null;
                        // Every affected row has to pass; the first offender is
                        // the one reported.
                        aContexts.some(function (oContext) {
                            sError = mGuard.validate.call(that, oContext);
                            return !!sError;
                        });

                        if (sError) {
                            MessageBox.error(sError);
                            return;
                        }

                        var sConfirm = mGuard.confirm ? mGuard.confirm.call(that, aContexts) : null;
                        if (!sConfirm) {
                            fnReplay();
                            return;
                        }

                        // Yes/No rather than OK/Cancel: a "Cancel" button in a
                        // dialog about cancelling a request reads both ways.
                        MessageBox.confirm(sConfirm, {
                            actions: [MessageBox.Action.YES, MessageBox.Action.NO],
                            emphasizedAction: MessageBox.Action.YES,
                            onClose: function (sAction) {
                                if (sAction === MessageBox.Action.YES) {
                                    fnReplay();
                                }
                            }
                        });
                    });
                });

                oButton.data(GUARD_FLAG, true);
            });
        },

        /**
         * The contexts a pressed action applies to: the page's own context for
         * an object page header button, or the selected rows for a table
         * toolbar button in the list report.
         */
        _resolveActionContexts: function (oButton) {
            var oContext = oButton.getBindingContext();
            if (oContext) { return [oContext]; }

            var oParent = oButton.getParent();
            while (oParent) {
                if (oParent.isA("sap.ui.mdc.Table")) {
                    return oParent.getSelectedContexts() || [];
                }
                oParent = oParent.getParent();
            }

            oContext = this.base.getView().getBindingContext();
            return oContext ? [oContext] : [];
        },

        /**
         * Load the properties a rule reads so it can then run synchronously off
         * the context. Values already in the model resolve without a request.
         * A property that cannot be read is logged and left undefined, which
         * lands the rule on its "nothing to check" branch rather than blocking
         * the user on a failed lookup.
         */
        _requestGuardProperties: function (aContexts, aProperties) {
            var aRequests = [];

            aContexts.forEach(function (oContext) {
                aProperties.forEach(function (sProperty) {
                    aRequests.push(
                        oContext.requestProperty(sProperty).catch(function (err) {
                            console.error("Failed to read " + sProperty + " for the action guard:", err);
                        })
                    );
                });
            });

            return Promise.all(aRequests);
        },

        /**
         * Reschedule rule. When security has already rescheduled this
         * appointment (isSecurityRescheduled = 'X', surfaced as the boolean
         * true) the employee may reschedule regardless of how close the
         * appointment is; otherwise the shared 24h cutoff below applies.
         */
        _validateReschedule: function (oContext) {
            if (isTrueFlag(oContext.getProperty("isSecurityRescheduled"))) {
                return null;
            }
            return this._validateAppointmentChange(oContext);
        },

        /**
         * An appointment may neither be rescheduled nor cancelled once it is
         * less than 24 hours away. Sticker admins are exempt and may do both at
         * any time; while the admin check is still pending the rule is
         * enforced, matching the restrictive default used for the action
         * visibility.
         */
        _validateAppointmentChange: function (oContext) {
            if (this._bIsStickerAdmin) { return null; }

            var oAppointment = toLocalDate(
                oContext.getProperty("AppointmentDate"),
                oContext.getProperty("AppointmentFromTime")
            );
            // No appointment booked yet — nothing to protect.
            if (!oAppointment) { return null; }

            var iHoursLeft = (oAppointment.getTime() - Date.now()) / MS_PER_HOUR;
            if (iHoursLeft < APPOINTMENT_CUTOFF_HOURS) {
                return "Please note that appointments can only be rescheduled or canceled up to " +
                    APPOINTMENT_CUTOFF_HOURS +
                    " hours before the approved appointment date and time.";
            }
            return null;
        },

        /**
         * Confirmation text for Cancel Request. The list report allows several
         * rows to be selected at once, so the count is spelled out.
         */
        _confirmCancel: function (aContexts) {
            if (aContexts.length > 1) {
                return "Are you sure you want to cancel the " + aContexts.length +
                    " selected requests? This cannot be undone.";
            }
            return "Are you sure you want to cancel this request? This cannot be undone.";
        },

        /**
         * A sticker can only be renewed inside the last 30 days of its validity:
         * not earlier than 30 days before ExpireDate, and not after it has
         * expired. Renewing on the expiry date itself is still allowed.
         */
        _validateRenew: function (oContext) {
            var oExpire = toLocalDate(oContext.getProperty("ExpireDate"));
            if (!oExpire) {
                return "This request cannot be renewed because it has no expiry date.";
            }

            var oToday = startOfToday();
            // Day difference rather than a raw ms division, so a DST switch
            // inside the window cannot shift the boundary by an hour.
            var iDaysLeft = Math.round((oExpire.getTime() - oToday.getTime()) / MS_PER_DAY);

            if (iDaysLeft < 0) {
                return "This sticker expired on " + formatDate(oExpire) +
                    " and can no longer be renewed.";
            }
            if (iDaysLeft > RENEW_WINDOW_DAYS) {
                return "This sticker expires on " + formatDate(oExpire) +
                    ". Renewal is only possible within " + RENEW_WINDOW_DAYS +
                    " days before the expiry date, from " +
                    formatDate(addDays(oExpire, -RENEW_WINDOW_DAYS)) + ".";
            }
            return null;
        },

        /**
         * Resolve a text from the app's i18n bundle, falling back to sFallback
         * if the "i18n" model (or the key) is not available.
         */
        _getText: function (sKey, sFallback) {
            var oModel = this.base.getView().getModel("i18n");
            var oBundle = oModel && oModel.getResourceBundle && oModel.getResourceBundle();
            return (oBundle && oBundle.getText(sKey)) || sFallback;
        },

        /**
         * Add a read-only "Contract End Date" row to the Renew Sticker action
         * dialog, placed just above the Appointment Date field. FE builds that
         * dialog itself and offers no slot for a non-parameter field, so it is
         * injected into the generated form once the dialog has opened. The value
         * is taken from the renewed request's ContractEnddate (preloaded by the
         * guard) and shown as static text — it is context, not an input.
         *
         * @param {sap.ui.model.odata.v4.Context} oContext The request being renewed.
         */
        _injectRenewContractEndDate: function (oContext) {
            var that = this;
            var sRaw = oContext.getProperty("ContractEnddate");
            var sValue = sRaw ? formatDate(toLocalDate(sRaw)) : "";

            // FE opens the dialog asynchronously (value lists, side effects), so
            // poll briefly for it rather than assume it is up on the next tick.
            var iTries = 0;
            var iMaxTries = 40; // ~4s at 100ms intervals
            var poll = function () {
                var oField = that._findRenewAppointmentDateField();
                if (oField) {
                    that._addContractEndDateField(oField, sValue);
                    return;
                }
                if (++iTries < iMaxTries) {
                    setTimeout(poll, 100);
                }
            };
            poll();
        },

        /**
         * The Appointment Date control inside the currently open Renew Sticker
         * action dialog, or null while no such dialog is open yet. FE names the
         * generated field after the "appointmentdate" action parameter, matched
         * here on either the control id or a value binding path.
         */
        _findRenewAppointmentDateField: function () {
            var aDialogs = Element.registry.filter(function (oControl) {
                return oControl.isA("sap.m.Dialog") && oControl.isOpen && oControl.isOpen();
            });

            for (var i = 0; i < aDialogs.length; i++) {
                var aMatches = aDialogs[i].findAggregatedObjects(true, function (oControl) {
                    return this._isAppointmentDateControl(oControl);
                }.bind(this));
                if (aMatches.length) {
                    return aMatches[0];
                }
            }
            return null;
        },

        _isAppointmentDateControl: function (oControl) {
            if ((oControl.getId() || "").toLowerCase().indexOf("appointmentdate") !== -1) {
                return true;
            }
            if (!oControl.getBindingInfo) { return false; }

            var aProps = ["value", "selectedKey", "additionalValue", "dateValue"];
            return aProps.some(function (sProp) {
                var oInfo = oControl.getBindingInfo(sProp);
                var aParts = oInfo && (oInfo.parts || [oInfo]);
                return !!aParts && aParts.some(function (oPart) {
                    return oPart && oPart.path &&
                        oPart.path.toLowerCase().indexOf("appointmentdate") !== -1;
                });
            });
        },

        /**
         * Insert the read-only Contract End Date row directly before the form
         * row that holds the Appointment Date field. Idempotent: a dialog that
         * already carries the injected row (e.g. reused by FE) is left untouched.
         *
         * @param {sap.ui.core.Control} oAppointmentField The Appointment Date field.
         * @param {string} sValue Formatted contract end date, or "" when unset.
         */
        _addContractEndDateField: function (oAppointmentField, sValue) {
            // Walk up to the form row (FormElement) that wraps the field.
            var oFormElement = oAppointmentField;
            while (oFormElement && !oFormElement.isA("sap.ui.layout.form.FormElement")) {
                oFormElement = oFormElement.getParent();
            }
            if (!oFormElement) { return; }

            var oContainer = oFormElement.getParent(); // FormContainer
            if (!oContainer || !oContainer.insertFormElement) { return; }

            var bAlready = oContainer.getFormElements().some(function (oExisting) {
                return oExisting.data(CONTRACT_END_FIELD_FLAG);
            });
            if (bAlready) { return; }

            var oNewElement = new FormElement({
                label: new Label({ text: this._getText("contractEndDate", "Contract End Date") }),
                fields: [ new Text({ text: sValue }) ]
            });
            oNewElement.data(CONTRACT_END_FIELD_FLAG, true);

            oContainer.insertFormElement(oNewElement, oContainer.indexOfFormElement(oFormElement));
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
            // Safe default: hide everything until authorization is known
            document.body.classList.add("hideMaintenanceActions");
            document.body.classList.add("hideAdminOnlyActions");

            var that = this;
            // Same restrictive default for the admin exemption in
            // _validateAppointmentChange: not an admin until proven otherwise.
            this._bIsStickerAdmin = false;

            var oView = this.base.getView();
            var oComponent = this.base.getAppComponent?.();

            var oVarModel =
                (oComponent && oComponent.getModel("varAuth")) ||
                (oView && oView.getModel("varAuth"));

            if (!oVarModel) {
                console.error("varAuth model not available.");
                return;
            }

            try {
                var oBinding = oVarModel.bindList(
                    "/EmployeeHeader",
                    null,
                    null,
                    null,
                    { $$groupId: "$direct" }
                );

                oBinding.requestContexts(0, 1).then(function (aContexts) {

                    var bIsStickerAdmin = false;

                    if (aContexts.length) {
                        bIsStickerAdmin =
                            aContexts[0].getObject()?.StickerAdmin === "X";
                    }

                    that._bIsStickerAdmin = bIsStickerAdmin;

                    if (bIsStickerAdmin) {
                        // Admin:
                        // Hide Create/Edit/Delete/Copy
                        // Show Maintain Appointment Location
                        document.body.classList.add("hideMaintenanceActions");
                        document.body.classList.remove("hideAdminOnlyActions");
                    } else {
                        // Non Admin:
                        // Show Create/Edit/Delete/Copy
                        // Hide Maintain Appointment Location
                        document.body.classList.remove("hideMaintenanceActions");
                        document.body.classList.add("hideAdminOnlyActions");
                    }

                }).catch(function (err) {
                    console.error(err);
                });

            } catch (err) {
                console.error(err);
            }
        }
    });
});
