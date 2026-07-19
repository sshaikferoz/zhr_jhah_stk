sap.ui.define([
    "sap/ui/core/Control"
], function (Control) {
    "use strict";

    /**
     * Wrapper that lays out its content in a responsive CSS grid
     * (css/style.css: .zhrSlotGrid); hosts the time-slot chips in the
     * TimeSlotPopover value help. Declares IFormContent so it could also sit
     * directly inside a form's ColumnLayout, which rejects VBox/HBox.
     */
    return Control.extend("com.jhah.zhrjhahsecstk.ext.control.SlotGrid", {
        metadata: {
            interfaces: ["sap.ui.core.IFormContent"],
            defaultAggregation: "content",
            aggregations: {
                content: { type: "sap.ui.core.Control", multiple: true }
            }
        },

        renderer: {
            apiVersion: 2,
            render: function (oRm, oControl) {
                oRm.openStart("div", oControl).class("zhrSlotGrid").openEnd();
                oControl.getContent().forEach(function (oChild) {
                    oRm.renderControl(oChild);
                });
                oRm.close("div");
            }
        }
    });
});
